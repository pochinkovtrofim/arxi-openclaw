import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type AgentSteerParams,
  type AgentSteerResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { ACTIVE_EMBEDDED_RUNS_BY_RUN_ID } from "../../agents/embedded-agent-runner/run-state.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { resolveSessionRuntimeCwd } from "../server-methods/agent-session-reset.js";
import { gatewayClientSenderFields } from "../server-methods/gateway-client-identity.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/shared-types.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import type { AgentTurnIo } from "./types.js";

const DEDUPE_PREFIX = "steer:";
const inFlight = new Map<string, { identity: string; result: Promise<AgentSteerResult> }>();

export class AgentSteerRequestError extends Error {}

/**
 * A message the run confirmed reading is answered by that run. When the host
 * lost the steer receipt and falls back to `agent` with the same key, it gets
 * the steered run back instead of a second turn; a steer still settling makes
 * the fallback retry later. An unconfirmed steer runs again as its own turn.
 */
export function replaySteeredAgentTurn(params: {
  idempotencyKey: string;
  context: Pick<GatewayRequestContext, "dedupe">;
  io: Pick<AgentTurnIo, "emitAcceptance">;
}): boolean {
  if (inFlight.has(params.idempotencyKey)) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "agent.steer for this message is still settling", {
        retryable: true,
      }),
    ]);
    return true;
  }
  const steered = params.context.dedupe.get(DEDUPE_PREFIX + params.idempotencyKey)?.payload as
    | AgentSteerResult
    | undefined;
  if (steered?.status !== "steered" || steered.transcriptCommit === "unconfirmed") {
    return false;
  }
  params.io.emitAcceptance([true, { runId: steered.runId, status: "ok", steered: true }, undefined], {
    cached: true,
    runId: steered.runId,
  });
  return true;
}

function notSteerable(reason: string, extra?: { activeRunId?: string }): AgentSteerResult {
  return { status: "not_steerable", reason, ...extra };
}

/**
 * Adds a follow-up message to the active run the host is already waiting on,
 * so that run produces one answer to both messages. Anything that cannot be
 * steered returns `not_steerable` without starting a run or writing the
 * transcript; the host then sends the message through `agent` as usual.
 */
export async function steerActiveAgentRun(params: {
  request: AgentSteerParams;
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "dedupe" | "logGateway">;
}): Promise<AgentSteerResult> {
  const { request, client, context } = params;
  // Only the local host that started the run may continue it. Internal runtime
  // clients (plugin subagents, nested runs) never hold this authority.
  if (
    client?.internal?.isLocalClient !== true ||
    !hasGatewayAdminScope(client) ||
    client.internal.agentRunTracking !== undefined ||
    client.internal.agentRuntimeIdentity !== undefined
  ) {
    throw new AgentSteerRequestError("agent.steer requires the trusted local host");
  }
  const identity = sha256Hex(
    JSON.stringify([
      request.sessionKey,
      request.agentId ?? "",
      request.expectedRunId,
      request.message,
    ]),
  );
  const done = context.dedupe.get(DEDUPE_PREFIX + request.idempotencyKey);
  if (done) {
    if (done.requestIdentity !== identity) {
      throw new AgentSteerRequestError("agent.steer idempotencyKey was reused for another message");
    }
    return done.payload as AgentSteerResult;
  }
  // A message that already started its own run is not a follow-up anymore.
  if (context.dedupe.get(`agent:${request.idempotencyKey}`)) {
    return notSteerable("idempotency_key_dispatched");
  }
  const pending = inFlight.get(request.idempotencyKey);
  if (pending) {
    if (pending.identity !== identity) {
      throw new AgentSteerRequestError("agent.steer idempotencyKey was reused for another message");
    }
    return pending.result;
  }
  const result = steer(request, client, context, identity);
  inFlight.set(request.idempotencyKey, { identity, result });
  try {
    return await result;
  } finally {
    inFlight.delete(request.idempotencyKey);
  }
}

async function steer(
  request: AgentSteerParams,
  client: GatewayClient,
  context: Pick<GatewayRequestContext, "dedupe" | "logGateway">,
  identity: string,
): Promise<AgentSteerResult> {
  const loaded = loadSessionEntry(
    request.sessionKey,
    request.agentId ? { agentId: request.agentId } : {},
  );
  const sessionKey = loaded.canonicalKey;
  const sessionId = normalizeOptionalString(loaded.entry?.sessionId);
  if (!sessionKey || !sessionId || !loaded.entry) {
    return notSteerable("no_session");
  }
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
  if (!target?.runId) {
    return notSteerable("no_active_run");
  }
  // The host names the run it is waiting on. A scheduled or background run in
  // the same session never absorbs the Owner's message.
  if (target.runId !== request.expectedRunId) {
    return notSteerable("run_mismatch", { activeRunId: target.runId });
  }
  const blockReason = resolveRestartRecoverySteeringBlockReason(
    loaded.entry,
    sessionId,
    normalizeOptionalString(target.sourceTurnId) ?? target.runId,
  );
  if (blockReason) {
    return notSteerable(blockReason, { activeRunId: target.runId });
  }
  // The follow-up continues the turn under that turn's own authority: the host
  // admitted both messages for the same requester and conversation, and the
  // expected run id above binds the steer to exactly that turn.
  const activeFingerprint = normalizeOptionalString(
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(target.runId)?.toolAuthorityFingerprint,
  );
  if (!activeFingerprint) {
    return notSteerable("injection_unavailable", { activeRunId: target.runId });
  }
  const agentId = loaded.agentId;
  const senderIsOwner = hasGatewayAdminScope(client);
  const recorder = createUserTurnTranscriptRecorder({
    input: {
      text: request.message,
      timestamp: Date.now(),
      idempotencyKey: buildRunUserTurnIdempotencyKey(request.idempotencyKey),
      ...gatewayClientSenderFields(client),
      senderIsOwner,
    },
    target: () => {
      const latest = loadSessionEntry(sessionKey, { agentId, clone: false });
      if (!latest.entry || latest.entry.sessionId?.trim() !== sessionId) {
        return undefined;
      }
      return {
        sessionId,
        expectedSessionId: sessionId,
        sessionKey,
        sessionEntry: latest.entry,
        sessionStore: latest.store,
        storePath: latest.storePath,
        agentId,
        cwd: resolveSessionRuntimeCwd({ sessionEntry: latest.entry }),
        config: latest.cfg,
      };
    },
    errorContext: "gateway agent steer transcript",
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    onPersistenceError: (error) => {
      context.logGateway.warn(
        `gateway agent steer transcript persistence failed: ${formatForLog(error)}`,
      );
    },
  });
  const attempt = beginReplyMessageInjectionTarget(target, request.message, {
    isInboundUserMessage: true,
    steeringMode: "all",
    toolAuthorityFingerprint: activeFingerprint,
    waitForTranscriptCommit: true,
    userTurnTranscriptRecorder: recorder,
    debounceMs: 0,
    // An own property like a user turn; the agent RPC never negotiates gateway suggestions.
    taskSuggestionDeliveryMode: undefined,
  });
  const finalized = await finalizeReplyMessageInjectionAttempt({
    attempt,
    target,
    // The first answer survives an uncertain receipt; the host reports the gap.
    abortOnUnconfirmedTranscript: false,
  });
  if (finalized.status === "rejected") {
    context.logGateway.info(
      `agent.steer not steerable: reason=${finalized.outcome.reason} runId=${target.runId}`,
    );
    return notSteerable(finalized.outcome.reason, { activeRunId: target.runId });
  }
  const runId = normalizeOptionalString(finalized.targetRunId) ?? target.runId;
  const unconfirmed =
    finalized.status === "indeterminate" ||
    finalized.outcome.result?.transcriptCommit === "unconfirmed";
  const payload: AgentSteerResult = {
    status: "steered",
    runId,
    ...(unconfirmed ? { transcriptCommit: "unconfirmed" as const } : {}),
  };
  context.dedupe.set(DEDUPE_PREFIX + request.idempotencyKey, {
    ts: Date.now(),
    ok: true,
    payload,
    requestIdentity: identity,
  });
  return payload;
}
