import type { PluginHookRegistration } from "./hook-types.js";

/** Gating hook phases whose sequential handlers delay the first model request. */
export type TimedHookPhase = "before_prompt_build" | "before_agent_run";

/** Content-free summary of one run's handlers for a gating hook phase. */
export type HookPhaseTimingSummary = {
  /** Wall time from the first handler start to the last handler end. */
  durationMs: number;
  /** Handlers that ran, including ones that failed or timed out. */
  count: number;
  /** Handlers stopped by their hook budget. */
  timeouts: number;
  /** Bounded code label of the slowest handler. */
  slowest: string;
  slowestMs: number;
};

type PhaseAccumulator = {
  startedAt: number;
  endedAt: number;
  count: number;
  timeouts: number;
  slowest: string;
  slowestMs: number;
};

const MAX_TRACKED_RUNS = 256;
const runs = new Map<string, Partial<Record<TimedHookPhase, PhaseAccumulator>>>();
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;

export function isTimedHookPhase(hookName: string): hookName is TimedHookPhase {
  return hookName === "before_prompt_build" || hookName === "before_agent_run";
}

/**
 * A handler label is code identity only: the plugin id plus its declared
 * registration id, or its dispatch index when it has none.
 */
export function hookTimingLabel(
  hook: Pick<PluginHookRegistration, "pluginId" | "registrationId">,
  index: number,
): string {
  const plugin = SAFE_SEGMENT.test(hook.pluginId) ? hook.pluginId : "plugin";
  return hook.registrationId && SAFE_SEGMENT.test(hook.registrationId)
    ? `${plugin}:${hook.registrationId}`
    : `${plugin}#${Math.max(0, Math.min(index, 99))}`;
}

/** Records one handler of a gating phase for the run that dispatched it. */
export function recordHookPhaseTiming(params: {
  runId: string;
  phase: TimedHookPhase;
  label: string;
  startedAt: number;
  endedAt: number;
  timedOut: boolean;
}): void {
  let phases = runs.get(params.runId);
  if (!phases) {
    if (runs.size >= MAX_TRACKED_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest !== undefined) {
        runs.delete(oldest);
      }
    }
    phases = {};
    runs.set(params.runId, phases);
  }
  const durationMs = Math.max(0, params.endedAt - params.startedAt);
  const current = phases[params.phase];
  if (!current) {
    phases[params.phase] = {
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      count: 1,
      timeouts: params.timedOut ? 1 : 0,
      slowest: params.label,
      slowestMs: durationMs,
    };
    return;
  }
  current.startedAt = Math.min(current.startedAt, params.startedAt);
  current.endedAt = Math.max(current.endedAt, params.endedAt);
  current.count += 1;
  current.timeouts += params.timedOut ? 1 : 0;
  if (durationMs > current.slowestMs) {
    current.slowest = params.label;
    current.slowestMs = durationMs;
  }
}

/** Returns and clears the run's phase timings, so each prompt build reports its own hooks. */
export function takeHookPhaseTimings(
  runId: string | undefined,
): Partial<Record<TimedHookPhase, HookPhaseTimingSummary>> {
  if (!runId) {
    return {};
  }
  const phases = runs.get(runId);
  runs.delete(runId);
  const result: Partial<Record<TimedHookPhase, HookPhaseTimingSummary>> = {};
  for (const phase of ["before_prompt_build", "before_agent_run"] as const) {
    const value = phases?.[phase];
    if (value) {
      result[phase] = {
        durationMs: Math.max(0, value.endedAt - value.startedAt),
        count: value.count,
        timeouts: value.timeouts,
        slowest: value.slowest,
        slowestMs: value.slowestMs,
      };
    }
  }
  return result;
}
