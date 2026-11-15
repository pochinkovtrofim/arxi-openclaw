import type { PreflightStepMoment } from "./diagnostic-events.js";

/**
 * Collects step moments for measurement. `record` never throws, so it is safe to hand to
 * code whose behaviour it must not change.
 */
export function createPreflightStepRecorder() {
  const steps: PreflightStepMoment[] = [];
  return {
    steps,
    record: (step: string) => {
      steps.push({ step, at: Date.now() });
    },
  };
}
