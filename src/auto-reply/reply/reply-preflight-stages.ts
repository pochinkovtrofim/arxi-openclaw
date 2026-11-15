import {
  emitTrustedDiagnosticEvent,
  type PreflightStepMoment,
  type REPLY_PREFLIGHT_STAGES,
  type ReplyPreflightSubStage,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";

// guest_dispatch is reported by the guest service, never marked here.
type ReplyPreflightStage = Exclude<(typeof REPLY_PREFLIGHT_STAGES)[number], "guest_dispatch">;

/** The span a closed stage covered (epoch ms). */
export type ReplyPreflightWindow = { startedAt: number; endedAt: number };

const SUB_STAGE_STEP = /^[a-z0-9_]{1,40}$/;

/**
 * Times a turn from the moment it is taken up to its agent run as consecutive stages:
 * each mark closes the stage that began where the previous one ended. Content-free;
 * outside a traced turn nothing is emitted.
 */
export function createReplyPreflightStages(params: { startedAt?: number; sessionKey?: string }) {
  const trace = getActiveDiagnosticTraceContext();
  let stageStartedAt = params.startedAt ?? Date.now();
  let memoryFlushed = false;
  let compacting = false;
  const emit = (
    stage: ReplyPreflightStage | ReplyPreflightSubStage,
    startedAt: number,
    endedAt: number,
  ) => {
    if (!trace) {
      return;
    }
    emitTrustedDiagnosticEvent({
      type: "reply.preflight.stage",
      stage,
      durationMs: Math.max(0, endedAt - startedAt),
      // A stage closed at a recorded moment is emitted later than it ended, so it
      // carries its start rather than leaving the reader to infer it from now.
      startedAt,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(trace)),
    });
  };
  const mark = (stage: ReplyPreflightStage, at?: number): ReplyPreflightWindow => {
    const endedAt = at ?? Date.now();
    const startedAt = stageStartedAt;
    stageStartedAt = endedAt;
    emit(stage, startedAt, endedAt);
    return { startedAt, endedAt };
  };
  return {
    /** Closes the open stage now and returns the window it covered. */
    mark: (stage: ReplyPreflightStage) => mark(stage),
    /**
     * Closes a stage at a recorded moment. A moment before the open stage began or after
     * now would break the contiguous timeline, so it is skipped; its time then counts
     * toward the next stage that closes.
     */
    markAt: (stage: ReplyPreflightStage, at: number): ReplyPreflightWindow | undefined => {
      if (!Number.isFinite(at) || at < stageStartedAt || at > Date.now()) {
        return undefined;
      }
      return mark(stage, at);
    },
    /**
     * Emits `<parent>.<step>` detail inside a closed stage's window, contiguous from its
     * start: each step ends at its recorded moment and begins where the previous one
     * ended. A moment before the cursor, after the window or not finite is skipped (its
     * time counts toward the next step), as is a step name outside the closed pattern.
     * Coverage detail only; the parent stage is unchanged.
     */
    subStages: (
      parent: ReplyPreflightStage,
      steps: ReadonlyArray<PreflightStepMoment> | undefined,
      window: ReplyPreflightWindow | undefined,
    ) => {
      if (!steps || !window) {
        return;
      }
      let cursor = window.startedAt;
      for (const { step, at } of steps) {
        if (
          !SUB_STAGE_STEP.test(step) ||
          !Number.isFinite(at) ||
          at < cursor ||
          at > window.endedAt
        ) {
          continue;
        }
        emit(`${parent}.${step}`, cursor, at);
        cursor = at;
      }
    },
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
    preflightDone: () =>
      mark(compacting ? "compaction" : memoryFlushed ? "replan" : "token_estimate"),
  };
}

export type ReplyPreflightStages = ReturnType<typeof createReplyPreflightStages>;
