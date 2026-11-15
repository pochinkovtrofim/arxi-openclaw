import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createRunPrepStageReporter } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createStageTimingTracker, formatStageTimings } from "openclaw/plugin-sdk/time-runtime";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";

/** Records startup before the native turn owns inference and tool execution. */
export function createCodexAttemptPreparationTiming(
  params: Pick<EmbeddedRunAttemptParamsV2, "runId" | "sessionId" | "sessionKey" | "config">,
) {
  const tracker = createStageTimingTracker();
  const stageIdentity = {
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  };
  // The work trace gets the same contiguous stages the slow-start log prints:
  // run preparation up to the native turn, then the native turn/start request.
  // Both reporters are created inside the harness run's scope, so their spans
  // hang off the run's span rather than the command's attempt trace.
  const reportPreparationStages = createRunPrepStageReporter({
    tracker,
    ...stageIdentity,
    finalStage: "native-turn-handoff",
  });
  const profilerEnabled = isCodexAppServerProfilerEnabled(params.config);
  const totalWarnMs = profilerEnabled ? 1_000 : 10_000;
  const stageWarnMs = profilerEnabled ? 500 : 5_000;
  const log = (stage: string, outcome: "completed" | "error" | "ready") => {
    const summary = tracker.snapshot();
    const lastStage = summary.stages.at(-1);
    const slowTotal = outcome !== "completed" && summary.totalMs >= totalWarnMs;
    const slowStage = outcome !== "ready" && (lastStage?.durationMs ?? 0) >= stageWarnMs;
    if (!slowTotal && !slowStage) {
      return;
    }
    embeddedAgentLog.warn(
      `codex app-server preparation timings runId=${params.runId} sessionId=${params.sessionId} stage=${stage} outcome=${outcome} totalMs=${summary.totalMs} stages=${formatStageTimings(summary.stages)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        stage,
        outcome,
        totalMs: summary.totalMs,
        stages: summary.stages,
      },
    );
  };
  return {
    async measure<T>(stage: string, run: () => Promise<T> | T): Promise<T> {
      let outcome: "completed" | "error" = "error";
      try {
        const result = await run();
        outcome = "completed";
        return result;
      } finally {
        tracker.mark(stage);
        // Emit completed slow stages immediately: a later stalled stage must
        // not erase the work already spent before the native turn starts.
        log(stage, outcome);
      }
    },
    ready() {
      reportPreparationStages();
      log("native-turn-handoff", "ready");
    },
    /**
     * Times the run's tail once the native turn completed: finalizing its result, the
     * turn cleanup, then releasing the attempt's tools and leases. `done` reports the
     * stages, so the seconds between the last model response and the run's end show.
     */
    turnSettle() {
      const settleTracker = createStageTimingTracker();
      const done = createRunPrepStageReporter({
        tracker: settleTracker,
        ...stageIdentity,
        finalStage: "native-turn-release",
      });
      return {
        mark: (stage: "native-turn-finalize" | "native-turn-cleanup") => settleTracker.mark(stage),
        done,
      };
    },
    /**
     * Times the native turn/start request, which runs from the model call's
     * start to the point the native runtime has accepted the turn. The first
     * request reports its own stage; a retry would only stretch it.
     */
    timeNativeTurnStart<T>(start: () => Promise<T>): () => Promise<T> {
      const turnStartTracker = createStageTimingTracker();
      const reportTurnStart = createRunPrepStageReporter({
        tracker: turnStartTracker,
        ...stageIdentity,
        finalStage: "native-turn-start",
      });
      return async () => {
        try {
          return await start();
        } finally {
          reportTurnStart();
        }
      };
    },
  };
}
