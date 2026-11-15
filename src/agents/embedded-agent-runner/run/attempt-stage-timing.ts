import { isMainThread, threadId } from "node:worker_threads";
import { getReplySettleStages } from "../../../auto-reply/reply/reply-settle-stages.js";
import {
  type PreflightStepMoment,
  RUN_ADMISSION_STEPS,
  type RunAdmissionStep,
} from "../../../infra/diagnostic-events.js";
import { placeStageTimings } from "../../../infra/run-prep-stages.js";
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

const runAdmissionSteps: ReadonlySet<string> = new Set(RUN_ADMISSION_STEPS);

/**
 * The startup checkpoints placed on the wall clock as `run_admission` steps, in order. The
 * tracker starts where the session's admission (preparation, placement, maintenance, the
 * lanes) ended. A name outside the closed step list (a measured span) is left out; its
 * time counts toward the next step.
 */
export function startupStageMoments(
  tracker: Pick<ReturnType<typeof createStageTimingTracker>, "snapshot">,
  now: number = Date.now(),
): PreflightStepMoment[] {
  const summary = tracker.snapshot();
  const admitted: PreflightStepMoment = { step: "session_admission", at: now - summary.totalMs };
  return [
    admitted,
    ...placeStageTimings(summary, now).flatMap((stage) => {
      const step = stage.name.replaceAll("-", "_");
      return runAdmissionSteps.has(step)
        ? [{ step: step as RunAdmissionStep, at: stage.endedAt }]
        : [];
    }),
  ];
}

/**
 * The turn's own run goes to its harness: its pre-run stages close, split into steps. The
 * last step runs from the dispatch checkpoint to this hand-off (the attempt's workspace,
 * prompt, skills and gateway tools).
 */
export function closeRunAdmission(
  tracker: Pick<ReturnType<typeof createStageTimingTracker>, "snapshot">,
  runId: string,
) {
  const now = Date.now();
  getReplySettleStages()?.runStarting(
    [...startupStageMoments(tracker, now), { step: "attempt_handoff", at: now }],
    runId,
  );
}

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
