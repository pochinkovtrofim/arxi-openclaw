import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import type { CapturedSessionEntryCurrentRead } from "../../config/sessions/session-entry-current.types.js";
import { listSqliteTargetCandidatePathsForSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fenceScheduledGatewayContextResolver } from "../../gateway/scheduled-run-gateway-context.js";
import {
  createAbortError,
  isAbortError,
  racePromiseWithAbortSignal,
} from "../../infra/abort-signal.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getPluginRegistryForContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createCommandBudget } from "../command/maintenance-budget.js";
import {
  loadAgentRunnerMemoryRuntime,
  loadSessionStoreRuntime,
} from "../command/runtime-loaders.js";
import { resolveColdCacheCompaction } from "../embedded-agent-runner/cold-cache-compaction.js";
import type { CompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { createSessionMaintenanceOwner } from "./coordinator.js";

const log = createSubsystemLogger("agents/session-maintenance");
export type SessionMaintenanceRequest = {
  prepared: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    storePath: string;
    timeoutMs: number;
    runtimePolicySessionKey?: string;
  };
  followupRun: FollowupRun;
  sessionId: string;
  lifecycleRevision: SessionEntry["lifecycleRevision"];
  lifecycleGeneration: string;
  startedAt: number;
  oneShotCliRun?: boolean;
  agentHarnessId?: string;
  compactionRequestBudget?: CompactionRequestBudget;
};

/** Copy data only: turn callbacks, tool grants, delivery context and writer custody stay behind. */
export function createSessionMaintenanceFollowup(params: {
  run: Pick<
    FollowupRun["run"],
    | "agentId"
    | "agentDir"
    | "workspaceDir"
    | "cwd"
    | "messageProvider"
    | "agentAccountId"
    | "chatType"
    | "conversationRoutePeerId"
    | "conversationToolPolicy"
    | "groupId"
    | "groupChannel"
    | "groupSpace"
    | "skillsSnapshot"
    | "thinkingCatalog"
    | "skipProviderRuntimeHints"
    | "thinkLevel"
    | "verboseLevel"
    | "timeoutMs"
    | "senderIsOwner"
  >;
  sessionEntry: SessionEntry;
  cfg: OpenClawConfig;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  provider: string;
  model: string;
  auth: Pick<FollowupRun["run"], "authProfileId" | "authProfileIdSource">;
}): FollowupRun {
  const { run, sessionEntry } = params;
  return {
    prompt: "",
    enqueuedAt: Date.now(),
    run: {
      agentId: run.agentId,
      agentDir: run.agentDir,
      sessionId: sessionEntry.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionKey ?? sessionEntry.sessionId,
      workspaceDir: run.workspaceDir,
      cwd: run.cwd ?? run.workspaceDir,
      runtimePolicySessionKey: params.runtimePolicySessionKey ?? params.sessionKey,
      config: params.cfg,
      messageProvider: run.messageProvider,
      agentAccountId: run.agentAccountId,
      chatType: run.chatType,
      conversationRoutePeerId: run.conversationRoutePeerId,
      conversationToolPolicy: run.conversationToolPolicy,
      groupId: run.groupId,
      groupChannel: run.groupChannel,
      groupSpace: run.groupSpace,
      provider: params.provider,
      model: params.model,
      authProfileId: params.auth.authProfileId,
      authProfileIdSource: params.auth.authProfileIdSource,
      blockReplyBreak: "message_end",
      skillsSnapshot: run.skillsSnapshot,
      thinkingCatalog: run.thinkingCatalog,
      skipProviderRuntimeHints: run.skipProviderRuntimeHints,
      thinkLevel: run.thinkLevel,
      verboseLevel: run.verboseLevel ?? "off",
      timeoutMs: run.timeoutMs,
      senderIsOwner: false,
    },
    // A pre-compaction flush resolves the source turn's audience from this, not the run's grant.
    memoryAudienceSenderIsOwner: run.senderIsOwner === true,
  };
}

/** Optional work has a fresh root and writer admission after the foreground owner closes. */
export function scheduleSessionMaintenance(
  request: SessionMaintenanceRequest,
  afterOwnerSettles?: Promise<boolean>,
): void {
  startSessionMaintenance(request, "after_turn", afterOwnerSettles);
}

const coldCacheAheadTimers = resolveGlobalSingleton(
  Symbol.for("openclaw.coldCacheAheadMaintenance"),
  () => new Map<string, ReturnType<typeof setTimeout>>(),
  (timers) => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  },
);

/**
 * After a completed turn, runs the cold-cache compaction while the prompt cache is still warm,
 * so the next turn does not wait for it. One timer per session: a later turn replaces it.
 * Its maintenance owner is preemptible, so a turn arriving meanwhile cancels it and runs on the
 * still-warm cache. Paused VMs, restarts and failures leave the next turn's own check in place.
 */
export function scheduleColdCacheAheadMaintenance(
  request: SessionMaintenanceRequest,
  afterOwnerSettles: Promise<boolean>,
): void {
  const sessionKey = request.prepared.sessionKey;
  const coldCache = resolveColdCacheCompaction({
    cfg: request.prepared.cfg,
    provider: request.followupRun.run.provider,
    modelId: request.followupRun.run.model,
    agentId: request.followupRun.run.agentId,
  });
  if (!sessionKey || !coldCache) {
    return;
  }
  void afterOwnerSettles.then(
    (completed) => {
      if (!completed) {
        return;
      }
      clearTimeout(coldCacheAheadTimers.get(sessionKey));
      const timer = setTimeout(() => {
        if (coldCacheAheadTimers.get(sessionKey) !== timer) {
          return;
        }
        coldCacheAheadTimers.delete(sessionKey);
        // The finished turn's trace closed long ago; this work belongs to no message.
        runWithDiagnosticTraceContext(undefined, () =>
          startSessionMaintenance({ ...request, startedAt: Date.now() }, "cold_cache_ahead"),
        );
      }, coldCache.aheadMs);
      timer.unref?.();
      coldCacheAheadTimers.set(sessionKey, timer);
    },
    () => {},
  );
}

function startSessionMaintenance(
  request: SessionMaintenanceRequest,
  mode: "after_turn" | "cold_cache_ahead",
  afterOwnerSettles?: Promise<boolean>,
): void {
  const { prepared, followupRun } = request;
  const sessionKey = prepared.sessionKey;
  if (!sessionKey) {
    return;
  }
  const sessionReadScope = {
    ...captureSessionTranscriptTargetBinding({
      agentId: followupRun.run.agentId,
      sessionId: request.sessionId,
      storePath: prepared.storePath,
      sessionKey,
    }),
    readConsistency: "latest" as const,
  };
  if (request.oneShotCliRun) {
    log.debug("Optional session maintenance skipped: one-shot CLI owns no post-return runtime.");
    return;
  }
  const pluginRegistry = getPluginRegistryForContext();
  if (!pluginRegistry) {
    log.warn("Optional session maintenance skipped: no active plugin registry.");
    return;
  }
  const resolveGatewayContext = fenceScheduledGatewayContextResolver(
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
  );
  let sourceIdentities: ReturnType<typeof readDatabasePathIdentitySync>[];
  try {
    sourceIdentities = listSqliteTargetCandidatePathsForSessionStorePath(
      sessionReadScope.storePath,
    ).map(readDatabasePathIdentitySync);
  } catch (error) {
    log.warn(`Optional session maintenance source unavailable: ${formatErrorMessage(error)}`);
    return;
  }
  const budget = createCommandBudget(request.startedAt, prepared.timeoutMs);
  if (budget.remainingMs() === 0) {
    budget.dispose();
    return;
  }
  let readSource: CapturedSessionEntryCurrentRead | undefined;
  const interrupted = new AbortController();
  const owner = createSessionMaintenanceOwner({
    sessionKey,
    preemptible: true,
    abortSignal: AbortSignal.any([interrupted.signal, budget.signal]),
  });
  const assertCurrent = () => {
    owner.assertCurrent();
    assertAgentRunLifecycleGenerationCurrent(request.lifecycleGeneration);
    if (resolveGatewayContext && !resolveGatewayContext()) {
      throw createAbortError("Optional maintenance Gateway instance retired");
    }
    readSource?.assertSourceCurrent();
  };
  const run = withPluginRuntimeGatewayRequestScope(
    {
      pluginRegistry,
      resolveGatewayContext,
      isWebchatConnect: () => false,
    },
    async () => {
      if (
        afterOwnerSettles &&
        !(await racePromiseWithAbortSignal(afterOwnerSettles, owner.signal))
      ) {
        log.debug(
          "Optional session maintenance skipped: foreground owner did not complete successfully.",
        );
        return;
      }
      return owner.run(() =>
        runWithGatewayIndependentRootWorkAdmission(
          async () => {
            assertCurrent();
            const { captureSessionEntryCurrentRead, withSessionEntryReadOnlyInWorker } =
              await loadSessionStoreRuntime();
            let entry: SessionEntry | undefined;
            const admission = await beginSessionWorkAdmission({
              scope: prepared.storePath,
              identities: [sessionKey, request.sessionId],
              signal: owner.signal,
              onInterrupt: () =>
                interrupted.abort(
                  createAbortError("Session maintenance writer admission interrupted"),
                ),
              assertAllowed: async () => {
                assertCurrent();
                entry = await withSessionEntryReadOnlyInWorker(
                  sessionReadScope,
                  assertCurrent,
                  async (read, source) => {
                    if (!read.ok) {
                      throw read.error;
                    }
                    const captured = captureSessionEntryCurrentRead(sessionReadScope, source);
                    if (
                      (readSource &&
                        (captured.kind !== readSource.kind ||
                          (captured.kind === "file" &&
                            readSource.kind === "file" &&
                            (captured.source.agentId !== readSource.source.agentId ||
                              captured.source.path !== readSource.source.path ||
                              captured.source.databaseIdentity !==
                                readSource.source.databaseIdentity ||
                              captured.source.databaseBirthtime !==
                                readSource.source.databaseBirthtime)))) ||
                      (captured.kind === "file" &&
                        !sourceIdentities.some(
                          (identity) =>
                            identity.canonicalPath === captured.source.path &&
                            identity.key === `file:${captured.source.databaseIdentity}` &&
                            identity.birthtime === captured.source.databaseBirthtime,
                        ))
                    ) {
                      throw createAbortError(
                        "Session maintenance database changed before admission",
                      );
                    }
                    readSource ??= captured;
                    return read.value;
                  },
                );
                assertCurrent();
                if (
                  !entry ||
                  entry.sessionId !== request.sessionId ||
                  entry.lifecycleRevision !== request.lifecycleRevision
                ) {
                  throw createAbortError("Session changed before optional maintenance admission");
                }
                if (entry.pendingFinalDelivery) {
                  throw createAbortError(
                    "Optional maintenance skipped while final delivery is pending",
                  );
                }
              },
            });
            try {
              await admission.run(async () => {
                assertCurrent();
                if (!entry) {
                  throw createAbortError("Session maintenance has no admitted session");
                }
                const sessionStore = { [sessionKey]: entry };
                const maintenanceParams = () => ({
                  cfg: prepared.cfg,
                  followupRun,
                  promptForEstimate: "",
                  defaultModel: followupRun.run.model,
                  sessionEntry: entry,
                  sessionStore,
                  sessionKey,
                  runtimePolicySessionKey: prepared.runtimePolicySessionKey ?? sessionKey,
                  storePath: prepared.storePath,
                  isHeartbeat: false,
                  abortSignal: owner.signal,
                });
                const memory = await loadAgentRunnerMemoryRuntime();
                assertCurrent();
                followupRun.run.timeoutMs = budget.remainingMs();
                assertCurrent();
                const flushMemory = (sessionEntry: SessionEntry) =>
                  memory.runMemoryFlushIfNeeded({
                    ...maintenanceParams(),
                    sessionEntry,
                    resolvedVerboseLevel: followupRun.run.verboseLevel ?? "off",
                  });
                if (mode === "cold_cache_ahead") {
                  // The reply path's cold-cache step: flush memory only when compaction follows.
                  await memory.runSessionCompactionIfNeeded({
                    ...maintenanceParams(),
                    coldCacheAhead: true,
                    compactionRequestBudget: request.compactionRequestBudget
                      ? { ...request.compactionRequestBudget, pendingTokens: 0 }
                      : undefined,
                    agentHarnessId: request.agentHarnessId,
                    authorize: () => {
                      assertCurrent();
                      return true;
                    },
                    beforeCompaction: async (current) => {
                      const flushed = await flushMemory(current);
                      assertCurrent();
                      entry = flushed.sessionEntry ?? current;
                      followupRun.run.sessionId = entry.sessionId;
                      followupRun.run.timeoutMs = budget.remainingMs();
                      return flushed.sessionEntry;
                    },
                  });
                  return;
                }
                const flushed = await flushMemory(entry);
                // Flush reports aborted attempts as failed outcomes; cancellation still forbids compaction.
                assertCurrent();
                entry = flushed.sessionEntry ?? entry;
                followupRun.run.sessionId = entry.sessionId;
                followupRun.run.timeoutMs = budget.remainingMs();
                assertCurrent();
                await memory.runSessionCompactionIfNeeded({
                  ...maintenanceParams(),
                  // The completed user is canonical history; do not reserve its input twice.
                  compactionRequestBudget: request.compactionRequestBudget
                    ? { ...request.compactionRequestBudget, pendingTokens: 0 }
                    : undefined,
                  agentHarnessId: request.agentHarnessId,
                  authorize: () => {
                    assertCurrent();
                    return true;
                  },
                });
              });
            } finally {
              admission.release();
            }
          },
          "session-maintenance",
          owner.signal,
        ),
      );
    },
  );
  void owner
    .track(run)
    .catch((error: unknown) => {
      if (owner.signal.aborted || isAbortError(error)) {
        log.debug(`Optional session maintenance cancelled: ${formatErrorMessage(error)}`);
      } else {
        log.warn(`Optional session maintenance failed: ${formatErrorMessage(error)}`);
      }
    })
    .finally(() => budget.dispose());
}
