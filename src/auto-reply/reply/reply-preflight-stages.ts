import {
  emitTrustedDiagnosticEvent,
  type REPLY_PREFLIGHT_STAGES,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";

type ReplyPreflightStage = (typeof REPLY_PREFLIGHT_STAGES)[number];

/**
 * Times a reply from its preparation to its agent run as consecutive stages: each call
 * closes the stage that began where the previous one ended. Content-free; outside a
 * traced reply nothing is emitted.
 */
export function createReplyPreflightStages(params: { startedAt: number; sessionKey?: string }) {
  const trace = getActiveDiagnosticTraceContext();
  let stageStartedAt = params.startedAt;
  return (stage: ReplyPreflightStage) => {
    const endedAt = Date.now();
    const durationMs = Math.max(0, endedAt - stageStartedAt);
    stageStartedAt = endedAt;
    if (!trace) {
      return;
    }
    emitTrustedDiagnosticEvent({
      type: "reply.preflight.stage",
      stage,
      durationMs,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(trace)),
    });
  };
}
