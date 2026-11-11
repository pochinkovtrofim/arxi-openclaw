import { isMainThread, threadId } from "node:worker_threads";
import {
  type DiagnosticContextStage,
  emitTrustedDiagnosticEvent,
} from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  type DiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  type createStageTimingTracker,
  formatStageTimings,
  type StageTimingSummary,
} from "../../../shared/stage-timing.js";

export const EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE = {
  workspace: "attempt-workspace",
  prompt: "attempt-prompt",
  runtimePlan: "attempt-runtime-plan",
  dispatch: "attempt-dispatch",
} as const;

const EMBEDDED_RUN_STAGE_WARN_TOTAL_MS = 10_000;
const EMBEDDED_RUN_STAGE_WARN_STAGE_MS = 5_000;

export function shouldWarnEmbeddedRunStageSummary(
  summary: StageTimingSummary,
  options?: {
    totalThresholdMs?: number;
    stageThresholdMs?: number;
  },
): boolean {
  const totalThresholdMs = options?.totalThresholdMs ?? EMBEDDED_RUN_STAGE_WARN_TOTAL_MS;
  const stageThresholdMs = options?.stageThresholdMs ?? EMBEDDED_RUN_STAGE_WARN_STAGE_MS;
  return (
    summary.totalMs >= totalThresholdMs ||
    summary.stages.some((stage) => stage.durationMs >= stageThresholdMs)
  );
}

export function createEmbeddedRunStageSummaryEmitter(options: {
  label: string;
  log: {
    isEnabled: (level: "trace") => boolean;
    warn: (message: string) => void;
    trace: (message: string) => void;
  };
  runId: string;
  sessionId?: string;
  tracker: ReturnType<typeof createStageTimingTracker>;
}): (phase: string) => void {
  return (phase) =>
    logEmbeddedRunStageSummary(
      options.tracker.snapshot(),
      options.log,
      () =>
        `[trace:embedded-run] ${options.label}: runId=${options.runId} sessionId=${options.sessionId} phase=${phase}`,
    );
}

export function logEmbeddedRunStageSummary(
  summary: StageTimingSummary,
  log: Parameters<typeof createEmbeddedRunStageSummaryEmitter>[0]["log"],
  prefix: () => string,
  thresholds?: Parameters<typeof shouldWarnEmbeddedRunStageSummary>[1],
): void {
  const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary, thresholds);
  if (shouldWarn || log.isEnabled("trace")) {
    const message = formatEmbeddedRunStageSummary(prefix(), summary);
    log[shouldWarn ? "warn" : "trace"](message);
  }
}

export function formatEmbeddedRunStageSummary(prefix: string, summary: StageTimingSummary): string {
  const stages = formatStageTimings(summary.stages);
  return `${prefix} pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} totalMs=${summary.totalMs} stages=${stages}`;
}

/**
 * Places each recorded stage on the wall clock. A summary measures from its
 * tracker's start, so that start is the summary's end minus its total.
 */
export function placeStageTimings(
  summary: StageTimingSummary,
  endedAt: number,
): DiagnosticContextStage[] {
  const trackerStartedAt = endedAt - summary.totalMs;
  return summary.stages.map((stage) => ({
    name: stage.name,
    startedAt: trackerStartedAt + stage.elapsedMs - stage.durationMs,
    endedAt: trackerStartedAt + stage.elapsedMs,
  }));
}

/**
 * Reports the attempt's preparation stages once, at its primary model request,
 * so the work trace shows where the time before the model went. Each attempt
 * of a run (a retry, a fallback) reports its own. Checkpoint stages are
 * contiguous; a measured stage (bundle-tools, tool-catalog) lies inside the
 * checkpoint after it (tool-preparation), so a sum must skip measured stages.
 */
export function createFirstModelRequestStageReporter(options: {
  tracker: Pick<ReturnType<typeof createStageTimingTracker>, "mark" | "snapshot">;
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  runTrace: DiagnosticTraceContext;
  now?: () => number;
}): () => void {
  let reported = false;
  const now = options.now ?? Date.now;
  return () => {
    if (reported) {
      return;
    }
    reported = true;
    options.tracker.mark("model-request");
    const stages = placeStageTimings(options.tracker.snapshot(), now());
    emitTrustedDiagnosticEvent({
      type: "context.stages",
      runId: options.runId,
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      stages,
      trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(options.runTrace)),
    });
  };
}
