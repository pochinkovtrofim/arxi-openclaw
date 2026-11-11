import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import {
  createSessionMaintenanceFollowup,
  scheduleColdCacheAheadMaintenance,
  scheduleSessionMaintenance,
} from "../../agents/session-maintenance/run.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

/** The descriptor contains no foreground authority; actual delivery settlement gates its new owner. */
export function scheduleReplySessionMaintenance(params: {
  context: FinalizeReplyAgentRunInput;
  accounting: AccountedAgentTurn;
  sessionEntry?: SessionEntry;
}): void {
  const { context, accounting, sessionEntry } = params;
  const { replyOperation, followupRun, cfg, sessionKey, storePath } = context;
  const meta = accounting.runResult.meta;
  const auth = context.execution.maintenanceAuthProfile;
  const lifecycleGeneration = replyOperation.lifecycleGeneration;
  if (
    !sessionEntry ||
    !sessionKey ||
    !storePath ||
    !accounting.providerUsed ||
    !replyOperation.ownerSettlement ||
    !lifecycleGeneration ||
    context.isHeartbeat ||
    accounting.preserveUserFacingSessionState ||
    context.execution.status !== "ok" ||
    accounting.fallbackExhausted ||
    accounting.autoCompactionCount > 0 ||
    meta?.aborted ||
    meta?.yielded ||
    meta?.error ||
    meta?.agentMeta?.agentHarnessId !== OPENCLAW_AGENT_RUNTIME_ID ||
    auth === undefined ||
    cfg.agents?.defaults?.compaction?.enabled === false
  ) {
    return;
  }
  const provider = accounting.providerUsed;
  const agentHarnessId = meta.agentMeta.agentHarnessId;
  const prepared = {
    cfg,
    sessionKey,
    storePath,
    timeoutMs: followupRun.run.timeoutMs,
    runtimePolicySessionKey: context.runtimePolicySessionKey,
  };
  const request = {
    prepared,
    followupRun: createSessionMaintenanceFollowup({
      run: followupRun.run,
      sessionEntry,
      cfg,
      sessionKey,
      runtimePolicySessionKey:
        context.runtimePolicySessionKey ?? followupRun.run.runtimePolicySessionKey,
      provider,
      model: accounting.modelUsed,
      auth,
    }),
    sessionId: sessionEntry.sessionId,
    lifecycleRevision: sessionEntry.lifecycleRevision,
    lifecycleGeneration,
    startedAt: replyOperation.startedAtMs,
    agentHarnessId,
    compactionRequestBudget: context.execution.compactionRequestBudget,
  };
  const completed = replyOperation.ownerSettlement.then(
    () => replyOperation.result?.kind === "completed" && !replyOperation.abortSignal.aborted,
  );
  const afterTurn = scheduleSessionMaintenance(request, completed);
  scheduleColdCacheAheadMaintenance(
    request,
    sessionEntry,
    afterTurn.then(() => completed),
  );
}
