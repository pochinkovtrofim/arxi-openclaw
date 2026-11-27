import { sha256Hex } from "../../infra/crypto-digest.js";
import type {
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionCloseReason,
  CliBackendLiveSessionEndCause,
  CliBackendLiveSessionHandle,
} from "../../plugins/cli-backend.types.js";
import { isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { runCliCleanup } from "./cleanup.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import { createCliFailoverError } from "./exit-error.js";
import {
  buildCliLiveSessionFingerprint,
  buildCliLiveSessionFingerprintParts,
  changedCliLiveSessionAuthorityPart,
  changedCliLiveSessionFingerprintPart,
  type CliLiveSessionFingerprintPartLabel,
  type CliLiveSessionFingerprintParts,
  onlyCliLiveSessionSkillsChanged,
} from "./live-session-fingerprint.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

const MAX_LIVE_SESSIONS = 16;
// A person's conversation keeps its process an hour between turns: a respawn
// costs every first reply after a pause more than a second, and one idle
// process fits. Background, cron and completion sessions keep the backend's own
// shorter default, since there can be many of them.
export const PERSON_TURN_LIVE_SESSION_IDLE_MS = 60 * 60 * 1_000;

// A person's own turn, or a background turn that continues their conversation.
// Delegated runs keep user provenance (Gateway `agent` calls carry
// trigger "user") but are not that conversation, and their processes are many.
function isPersonConversationRun(params: PreparedCliRunContext["params"]): boolean {
  const continuesConversation = params.continuesConversation === true;
  if (params.trigger !== "user" && !continuesConversation) {
    return false;
  }
  if (
    isSubagentSessionKey(params.sessionKey) ||
    params.spawnedBy ||
    params.trustedInternalHandoff ||
    params.inputProvenance?.kind === "inter_session"
  ) {
    return false;
  }
  // A continuing heartbeat is internal_system by provenance and still the conversation.
  return continuesConversation || params.inputProvenance?.kind !== "internal_system";
}

type CliLiveSessionOwner = {
  backendId: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

type CliLiveSessionRecord = {
  ownerKey: string;
  handle: CliBackendLiveSessionHandle;
  owner: PreparedCliRunContext["preparedBackend"];
  approvalGrants: Set<string>;
  cleanup?: () => Promise<void>;
  cleanupPromise?: Promise<void>;
  /** Layout of the native skills plugin dir this record claimed and cleans up. */
  skillsReloadLayout?: string;
  capture?: {
    token: string;
    key: string;
    revoke: () => void;
  };
};

// A Gateway restart in place keeps this process and its warm CLI children, but
// replaces the loopback MCP runtime and bearers they were started with; the
// fingerprint ignores the port and token, so a later turn would reuse a child
// that can no longer reach its tools (2026-11-23 every run in the restarted
// conversation hung). The restart and close lifecycles close and retire every
// live process; its conversation starts a new one once the old one has exited.
const liveSessions = resolveGlobalMap<string, CliLiveSessionRecord>(
  Symbol.for("openclaw.cliLiveSessions"),
  (sessions) => {
    const errors: unknown[] = [];
    for (const record of [...sessions.values()]) {
      try {
        record.handle.close("restart");
      } catch (error) {
        errors.push(error);
      }
      retireRecord(record, "restart");
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Some CLI live sessions did not close on restart");
    }
  },
  "close-and-restart",
);
// Why each conversation's last process ended, and each live process's
// fingerprint inputs: the next turn's start reason in the trace.
const lastEndCause = new Map<string, CliBackendLiveSessionEndCause>();
const handleFingerprintParts = new WeakMap<
  CliBackendLiveSessionHandle,
  CliLiveSessionFingerprintParts
>();
const startReasons = new WeakMap<PreparedCliRunContext, CliLiveSessionStartReason>();
const evictedHandles = new WeakSet<CliBackendLiveSessionHandle>();
// Conversations whose process ended and that have not started another; the
// oldest is forgotten past this, so one-off and cron conversations stay bounded.
const MAX_REMEMBERED_END_CAUSES = 256;

function rememberEndCause(ownerKey: string, cause: CliBackendLiveSessionEndCause): void {
  lastEndCause.delete(ownerKey);
  lastEndCause.set(ownerKey, cause);
  if (lastEndCause.size > MAX_REMEMBERED_END_CAUSES) {
    const oldest = lastEndCause.keys().next().value;
    if (oldest !== undefined) {
      lastEndCause.delete(oldest);
    }
  }
}

export type CliLiveSessionStartReason =
  | "reused"
  | "skills-reload"
  | "new"
  | CliBackendLiveSessionEndCause
  | `fingerprint-${CliLiveSessionFingerprintPartLabel}`;

/**
 * Why this turn's CLI process was reused or started: "reused", "skills-reload"
 * (reused after it rescanned edited skills), "new" (no
 * process for this conversation yet in this Gateway), the cause the previous
 * process ended with, or "fingerprint-<input>" when an input of the warm
 * process changed. A closed list, never content.
 */
export function getCliLiveSessionStartReason(
  context: PreparedCliRunContext,
): CliLiveSessionStartReason | undefined {
  return startReasons.get(context);
}
const retiredSessionCleanup = new Map<string, Promise<void>>();
const retiringSessionHandles = new WeakSet<CliBackendLiveSessionHandle>();

/** Takes a record out of the registry; its process-owned cleanup runs at exit. */
function retireRecord(record: CliLiveSessionRecord, cause: CliBackendLiveSessionEndCause): void {
  const { ownerKey, handle } = record;
  if (liveSessions.get(ownerKey) !== record) {
    return;
  }
  rememberEndCause(ownerKey, evictedHandles.has(handle) ? "evicted" : cause);
  record.capture?.revoke();
  liveSessions.delete(ownerKey);
  record.approvalGrants.clear();
  retiringSessionHandles.add(handle);
  // Native runtime artifacts remain process-owned until its child exits.
  record.cleanupPromise = Promise.resolve()
    .then(() => handle.waitForExit())
    .then(() => record.cleanup?.())
    .then(() => {
      retiringSessionHandles.delete(handle);
      if (retiredSessionCleanup.get(ownerKey) === record.cleanupPromise) {
        retiredSessionCleanup.delete(ownerKey);
      }
    });
  // A fresh prepared context must still join the retired owner after a timeout.
  retiredSessionCleanup.set(ownerKey, record.cleanupPromise);
  void record.cleanupPromise.catch((error: unknown) => {
    cliBackendLog.warn(`cli live session cleanup failed: ${String(error)}`);
  });
}

function buildCliLiveRegistryKey(owner: CliLiveSessionOwner): string {
  return `${owner.backendId}:${buildCliLiveOwnerKey(owner)}`;
}

/** One conversation owns the queue and process slot, regardless of its inbound route. */
export function buildCliLiveOwnerKey(input: Omit<CliLiveSessionOwner, "backendId">): string {
  return sha256Hex(
    JSON.stringify({
      agentId: input.agentId,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
    }),
  );
}

function buildCliLiveSessionKey(context: PreparedCliRunContext): string {
  return buildCliLiveRegistryKey({
    backendId: context.backendResolved.id,
    agentId: context.params.agentId,
    sessionId: context.params.sessionId,
    sessionKey: context.params.sessionKey,
  });
}

/** Returns whether this owner still has an in-process plugin-owned session. */
export function hasCliLiveSession(owner: CliLiveSessionOwner): boolean {
  return getCliLiveSessionGeneration(owner) !== undefined;
}

/** Returns the opaque generation of this owner's registered execution session. */
export function getCliLiveSessionGeneration(owner: CliLiveSessionOwner): string | undefined {
  return liveSessions.get(buildCliLiveRegistryKey(owner))?.handle.generation;
}

/** Reads owner-private standing approvals only from this exact current live process. */
export function getCliLiveSessionApprovalGrants(
  context: PreparedCliRunContext,
): Set<string> | undefined {
  const record = liveSessions.get(buildCliLiveSessionKey(context));
  return record?.owner === context.preparedBackend ? record.approvalGrants : undefined;
}

/** Closes the live execution session associated with a prepared run context, if one exists. */
export async function closeCliLiveSession(
  context: PreparedCliRunContext,
  reason: CliBackendLiveSessionCloseReason,
): Promise<void> {
  await runCliCleanup(context.params, "cli-live-session-close", async () => {
    await context.preparedBackend.closeLiveSession?.(reason);
  });
}

/** Explicit fresh/fork execution owns replacement of the current idle process. */
export async function restartCliLiveSession(
  context: PreparedCliRunContext,
  signal = context.params.abortSignal,
): Promise<void> {
  const assertActive = createCliRunCurrentAssertion(context.params, signal);
  assertActive();
  const key = buildCliLiveSessionKey(context);
  const record = liveSessions.get(key);
  const pendingCleanup = retiredSessionCleanup.get(key);
  await runCliCleanup(
    context.params,
    "cli-live-session-close",
    async () => {
      assertActive();
      await context.preparedBackend.closeLiveSession?.("restart");
      await pendingCleanup;
    },
    "required",
  );
  if (record) {
    await runCliCleanup(
      context.params,
      "cli-live-session-restart",
      () => {
        // One-shot cleanup schedules this callback; fence the actual close.
        assertActive();
        return closeRecord(record, "restart");
      },
      "required",
    );
  }
  assertActive();
}

async function closeRecord(
  record: CliLiveSessionRecord,
  reason: CliBackendLiveSessionCloseReason,
): Promise<void> {
  if (!record.cleanupPromise) {
    record.handle.close(reason);
  }
  await (record.cleanupPromise ?? record.handle.waitForExit());
}

function retainCleanup(context: PreparedCliRunContext, record: CliLiveSessionRecord): void {
  const owner = context.preparedBackend;
  record.owner = owner;
  owner.closeLiveSession = async (reason) => {
    // Natural removal retains this exact cleanup promise. A later turn may
    // borrow the live process, but the old turn cannot close that successor.
    if (record.owner === owner || record.cleanupPromise) {
      await closeRecord(record, reason);
    }
  };
}

function ensureCliLiveSessionCapacity(context: PreparedCliRunContext): void {
  if (liveSessions.size < MAX_LIVE_SESSIONS) {
    return;
  }
  for (const { handle } of liveSessions.values()) {
    if (handle.isIdle()) {
      evictedHandles.add(handle);
      handle.close("idle");
      return;
    }
  }
  throw createCliFailoverError("Too many CLI live sessions are active.", "rate_limit", {
    provider: context.params.provider,
    model: context.modelId,
    sessionId: context.params.sessionId,
    lane: context.params.lane,
  });
}

/** Returns whether this prepared local plugin transport may retain its execution process. */
export function acceptsCliLiveSession(context: PreparedCliRunContext): boolean {
  return (
    context.executionTarget.kind === "plugin" &&
    context.preparedBackend.backend.liveSession !== undefined &&
    context.preparedBackend.backend.output === "jsonl" &&
    context.preparedBackend.backend.input === "stdin"
  );
}

/**
 * A day summary is a silent turn sent to the warm process the person's last turn left:
 * that process keeps the system prompt and tools it started with, so the summary reads
 * the conversation from the prompt cache whatever its own rebuilt inputs say. They are
 * rebuilt under the summary's system admission, which shapes tools and prompt unlike the
 * person's turn, and never matched (every background summary was refused, 2026-11-18 to
 * 27). So the summary adopts the warm process's inputs when it runs with the same
 * account, credential, model and workspace; its tool calls still go through its own MCP
 * grant, which `activate` transfers to the process.
 */
function adoptWarmDaySummaryInputs(params: {
  context: PreparedCliRunContext;
  ownerKey: string;
  requiredGeneration: string | undefined;
  fingerprint: string;
  fingerprintParts: CliLiveSessionFingerprintParts;
}): { fingerprint: string; fingerprintParts: CliLiveSessionFingerprintParts } {
  const built = { fingerprint: params.fingerprint, fingerprintParts: params.fingerprintParts };
  if (params.context.params.controlOperation !== "day-summary" || !params.requiredGeneration) {
    return built;
  }
  const handle = liveSessions.get(params.ownerKey)?.handle;
  const warmParts = handle ? handleFingerprintParts.get(handle) : undefined;
  if (
    !handle ||
    !warmParts ||
    handle.generation !== params.requiredGeneration ||
    handle.fingerprint === params.fingerprint
  ) {
    return built;
  }
  const authority = changedCliLiveSessionAuthorityPart(warmParts, params.fingerprintParts);
  if (authority) {
    cliBackendLog.info(`cli day summary refused the warm process: changed=${authority}`);
    return built;
  }
  const rebuilt = changedCliLiveSessionFingerprintPart(warmParts, params.fingerprintParts);
  cliBackendLog.info(`cli day summary adopted the warm process: rebuilt=${rebuilt}`);
  return { fingerprint: handle.fingerprint, fingerprintParts: warmParts };
}

/** Creates host-owned lifecycle authority without exposing owner keys or bearer material. */
export function createCliLiveSessionCapability(params: {
  context: PreparedCliRunContext;
  argv: readonly string[];
  argv0?: string;
  env: Record<string, string>;
  captureKey?: string;
  beginCapture: (captureKey: string | undefined) => void;
  abortSignal: AbortSignal;
  requiredGeneration?: string;
  claimResources?: () => (() => Promise<void>) | undefined;
}): CliBackendLiveSessionCapability {
  const ownerKey = buildCliLiveSessionKey(params.context);
  const fingerprintInput = {
    context: params.context,
    argv: params.argv,
    argv0: params.argv0,
    env: params.env,
  };
  const { fingerprint, fingerprintParts } = adoptWarmDaySummaryInputs({
    context: params.context,
    ownerKey,
    requiredGeneration: params.requiredGeneration,
    fingerprint: buildCliLiveSessionFingerprint(fingerprintInput),
    fingerprintParts: buildCliLiveSessionFingerprintParts(fingerprintInput),
  });
  const grant = params.context.preparedBackend.mcpClientGrantCapture;
  if (Boolean(grant) !== Boolean(params.captureKey)) {
    throw new Error("CLI live process and current turn disagree about MCP capture ownership.");
  }

  const requiredSessionError = (code: "cli_live_session_changed" | "cli_live_session_missing") =>
    createCliFailoverError(
      "Managed CLI live session is no longer reusable.",
      "session_expired",
      {
        provider: params.context.params.provider,
        model: params.context.modelId,
        sessionId: params.context.params.sessionId,
        lane: params.context.params.lane,
      },
      { code },
    );
  const assertActive = createCliRunCurrentAssertion(params.context.params, params.abortSignal);
  const requireRegisteredRecord = (handle: CliBackendLiveSessionHandle) => {
    assertActive();
    const record = liveSessions.get(ownerKey);
    if (handle.fingerprint !== fingerprint || record?.handle !== handle) {
      throw new Error("CLI live session no longer belongs to this admitted run.");
    }
    if (params.requiredGeneration && params.requiredGeneration !== handle.generation) {
      throw requiredSessionError("cli_live_session_changed");
    }
    return record;
  };
  // Edited skill files reach a process whose plugin dir links their source dirs
  // once it rescans; any other changed input still needs a new process.
  const skillsReloadable = (handle: CliBackendLiveSessionHandle) => {
    assertActive();
    const record = liveSessions.get(ownerKey);
    const previous = handleFingerprintParts.get(handle);
    return (
      record?.handle === handle &&
      (!params.requiredGeneration || params.requiredGeneration === handle.generation) &&
      record.skillsReloadLayout !== undefined &&
      record.skillsReloadLayout === params.context.preparedBackend.skillsReloadLayout &&
      previous !== undefined &&
      onlyCliLiveSessionSkillsChanged(previous, fingerprintParts)
    );
  };

  return Object.freeze({
    fingerprint,
    ...(isPersonConversationRun(params.context.params)
      ? { idleTimeoutMs: PERSON_TURN_LIVE_SESSION_IDLE_MS }
      : {}),
    current: () => {
      assertActive();
      const handle = liveSessions.get(ownerKey)?.handle;
      startReasons.set(
        params.context,
        !handle
          ? (lastEndCause.get(ownerKey) ?? "new")
          : handle.fingerprint === fingerprint
            ? "reused"
            : `fingerprint-${changedCliLiveSessionFingerprintPart(handleFingerprintParts.get(handle), fingerprintParts)}`,
      );
      if (params.requiredGeneration && handle?.generation !== params.requiredGeneration) {
        throw requiredSessionError(
          handle ? "cli_live_session_changed" : "cli_live_session_missing",
        );
      }
      if (params.requiredGeneration && handle?.fingerprint !== fingerprint) {
        throw requiredSessionError("cli_live_session_changed");
      }
      return handle;
    },
    restart: async () => {
      assertActive();
      if (params.requiredGeneration) {
        throw requiredSessionError("cli_live_session_changed");
      }
      await restartCliLiveSession(params.context, params.abortSignal);
    },
    reloadSkills: async (handle, reload) => {
      if (!skillsReloadable(handle)) {
        return false;
      }
      try {
        await reload();
      } catch (error) {
        cliBackendLog.warn(`cli live session skills reload failed: ${String(error)}`);
        return false;
      }
      // The process may have ended or been replaced while it rescanned.
      if (!skillsReloadable(handle)) {
        return false;
      }
      handle.fingerprint = fingerprint;
      handleFingerprintParts.set(handle, fingerprintParts);
      startReasons.set(params.context, "skills-reload");
      return true;
    },
    register: (handle) => {
      assertActive();
      if (retiredSessionCleanup.has(ownerKey)) {
        throw new Error("Previous CLI live session cleanup has not settled.");
      }
      if (params.requiredGeneration) {
        throw requiredSessionError("cli_live_session_changed");
      }
      if (
        handle.fingerprint !== fingerprint ||
        !handle.generation.trim() ||
        liveSessions.has(ownerKey) ||
        // Owner keys stay private; one process handle must never cross owners.
        retiringSessionHandles.has(handle) ||
        Array.from(liveSessions.values()).some((record) => record.handle === handle)
      ) {
        throw new Error("CLI live session registration does not match its admitted owner.");
      }
      ensureCliLiveSessionCapacity(params.context);
      const cleanup = params.claimResources?.();
      const record: CliLiveSessionRecord = {
        ownerKey,
        handle,
        owner: params.context.preparedBackend,
        approvalGrants: new Set(),
        ...(cleanup ? { cleanup } : {}),
        // Only the record that claimed the plugin dir keeps it until exit.
        ...(cleanup && params.context.preparedBackend.skillsReloadLayout
          ? { skillsReloadLayout: params.context.preparedBackend.skillsReloadLayout }
          : {}),
        ...(grant && params.captureKey
          ? {
              capture: {
                token: grant.transportToken,
                key: params.captureKey,
                revoke: grant.revokeProcessToken,
              },
            }
          : {}),
      };
      liveSessions.set(ownerKey, record);
      lastEndCause.delete(ownerKey);
      handleFingerprintParts.set(handle, fingerprintParts);
      retainCleanup(params.context, record);
      cliBackendLog.info(
        `cli live session start: provider=${params.context.backendResolved.id} model=${params.context.normalizedModel} activeSessions=${liveSessions.size}`,
      );
    },
    activate: (handle) => {
      const record = requireRegisteredRecord(handle);
      if (Boolean(record.capture) !== Boolean(grant)) {
        throw new Error("CLI live session MCP topology changed across admitted turns.");
      }
      if (record.capture && grant) {
        // Transfer the exact current admission before activating the original
        // child capture header; copied bearers never carry authority alone.
        grant.adoptProcessToken(record.capture.token);
        requireRegisteredRecord(handle);
        params.beginCapture(record.capture.key);
      }
      retainCleanup(params.context, record);
    },
    remove: (handle, cause) => {
      const record = liveSessions.get(ownerKey);
      if (record?.handle !== handle) {
        return;
      }
      retireRecord(record, cause ?? "unspecified");
    },
  });
}
