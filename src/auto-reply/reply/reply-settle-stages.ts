import { AsyncLocalStorage } from "node:async_hooks";
import {
  emitTrustedDiagnosticEvent,
  type REPLY_SETTLE_STAGES,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";

type ReplySettleStage = (typeof REPLY_SETTLE_STAGES)[number];

/**
 * Times a turn from the end of its agent run to the reply's hand-off to the channel as
 * consecutive stages: each mark closes the stage that began where the previous one ended.
 * Content-free; outside a traced turn nothing is emitted. Every event carries its own child
 * span of the turn trace, so no two records share a span id.
 */
export function createReplySettleStages(params: {
  runId?: string;
  sessionKey?: string;
  /** Closes the pre-run stages where the agent run begins. */
  onRunStarting?: () => void;
}) {
  const trace = getActiveDiagnosticTraceContext();
  let stageStartedAt: number | undefined;
  let closed = false;
  let runStarted = false;
  return {
    /** The agent run is about to start; the first call closes the pre-run stages. */
    runStarting: () => {
      if (runStarted) {
        return;
      }
      runStarted = true;
      params.onRunStarting?.();
    },
    /** Starts the clock where the agent run returned; a later run attempt restarts it. */
    runEnded: () => {
      stageStartedAt = Date.now();
      closed = false;
    },
    mark: (stage: ReplySettleStage) => {
      if (stageStartedAt === undefined || closed) {
        return;
      }
      const endedAt = Date.now();
      const durationMs = Math.max(0, endedAt - stageStartedAt);
      stageStartedAt = endedAt;
      if (stage === "send") {
        closed = true;
      }
      if (!trace) {
        return;
      }
      emitTrustedDiagnosticEvent({
        type: "reply.settle.stage",
        stage,
        durationMs,
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(trace)),
      });
    },
  };
}

export type ReplySettleStages = ReturnType<typeof createReplySettleStages>;

const settleStagesScope = new AsyncLocalStorage<ReplySettleStages>();

/** Binds a turn's settle stages so the run and delivery code can mark them without plumbing. */
export function runWithReplySettleStages<T>(stages: ReplySettleStages, run: () => T): T {
  return settleStagesScope.run(stages, run);
}

export function getReplySettleStages(): ReplySettleStages | undefined {
  return settleStagesScope.getStore();
}
