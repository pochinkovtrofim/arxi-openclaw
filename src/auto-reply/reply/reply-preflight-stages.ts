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
 * Times a turn from the moment it is taken up to its agent run as consecutive stages:
 * each mark closes the stage that began where the previous one ended. Content-free;
 * outside a traced turn nothing is emitted.
 */
export function createReplyPreflightStages(params: { startedAt: number; sessionKey?: string }) {
  const trace = getActiveDiagnosticTraceContext();
  let stageStartedAt = params.startedAt;
  let memoryFlushed = false;
  let compacting = false;
  const mark = (stage: ReplyPreflightStage) => {
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
  return {
    mark,
    /** Wraps the memory checkpoint that the cold-cache or token compaction runs first. */
    memoryFlush: async <T>(run: () => Promise<T>): Promise<T> => {
      mark("token_estimate");
      try {
        return await run();
      } finally {
        mark("memory_flush");
        memoryFlushed = true;
      }
    },
    compactionStarted: () => {
      mark(memoryFlushed ? "replan" : "token_estimate");
      compacting = true;
    },
    /** Closes the required pre-run compaction step, whichever of its parts ran. */
    preflightDone: () => mark(compacting ? "compaction" : memoryFlushed ? "replan" : "token_estimate"),
  };
}

export type ReplyPreflightStages = ReturnType<typeof createReplyPreflightStages>;
