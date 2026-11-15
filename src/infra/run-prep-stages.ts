import { AsyncLocalStorage } from "node:async_hooks";
import type { createStageTimingTracker, StageTimingSummary } from "../shared/stage-timing.js";
import { emitTrustedDiagnosticEvent, type DiagnosticContextStage } from "./diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";

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
 * Reports a run's preparation stages once, when its runtime hands the first
 * request to the model, so the work trace shows where the time before the
 * model went. Every runner (embedded, CLI, Codex app-server) reports through
 * this one implementation, and a test pins that each one does. Each attempt of
 * a run (a retry, a fallback) reports its own. Checkpoint stages are contiguous;
 * a measured stage (bundle-tools, tool-catalog) lies inside the checkpoint after
 * it (tool-preparation), so a sum must skip measured stages. `finalStage` names
 * the last checkpoint, from the previous one to the hand-off.
 *
 * Stage spans hang off the run's own span, the parent its model calls use. The
 * exporter resolves a parent only among spans it tracks; a trace it never
 * tracked (the command's attempt trace) leaves the stages parentless and the
 * host never joins them to the turn. So the reporter takes the trace active at
 * creation, the run's span when created inside the run; `runTrace` is only for
 * a runner that creates it outside its run scope.
 */
export function createRunPrepStageReporter(options: {
  tracker: Pick<ReturnType<typeof createStageTimingTracker>, "mark" | "snapshot">;
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  runTrace?: DiagnosticTraceContext;
  finalStage?: string;
  now?: () => number;
}): () => void {
  let reported = false;
  const now = options.now ?? Date.now;
  const runTrace = freezeDiagnosticTraceContext(
    options.runTrace ?? getActiveDiagnosticTraceContext() ?? createDiagnosticTraceContext(),
  );
  return () => {
    if (reported) {
      return;
    }
    reported = true;
    options.tracker.mark(options.finalStage ?? "model-request");
    const stages = placeStageTimings(options.tracker.snapshot(), now());
    emitTrustedDiagnosticEvent({
      type: "context.stages",
      runId: options.runId,
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      stages,
      trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(runTrace)),
    });
  };
}

type PrepStageMeasure = Pick<ReturnType<typeof createStageTimingTracker>, "measure">;

const activePrepStages = new AsyncLocalStorage<PrepStageMeasure>();

/**
 * Runs a runner's preparation with its stage tracker in scope, so code deep in
 * that preparation (the MCP catalog, a requester's MCP runtime) can time its
 * own steps with measurePrepStage without the tracker threaded through.
 */
export function withPrepStages<T>(tracker: PrepStageMeasure, run: () => T): T {
  return activePrepStages.run(tracker, run);
}

/** Work a preparation starts but does not wait for (a re-resolution after the turn) is not its stage. */
export function outsidePrepStages<T>(run: () => T): T {
  return activePrepStages.exit(run);
}

/**
 * Times one step inside the current checkpoint as a measured stage of the
 * run's preparation. Outside a preparation (a later tool call, a background
 * refresh) it only runs the step.
 */
export function measurePrepStage<T>(name: string, run: () => Promise<T>): Promise<T> {
  const tracker = activePrepStages.getStore();
  return tracker ? tracker.measure(name, run) : run();
}
