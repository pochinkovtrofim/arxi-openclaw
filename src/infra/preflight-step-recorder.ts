import type { PreflightStep, PreflightStepMoment } from "./diagnostic-events.js";

/**
 * Collects step moments for measurement. `record` never throws, so it is safe to hand to
 * code whose behaviour it must not change. A step recorded again (a retried write) keeps
 * only its last moment.
 */
export function createPreflightStepRecorder<S extends PreflightStep>() {
  const steps: PreflightStepMoment[] = [];
  return {
    steps,
    record: (step: S) => {
      const earlier = steps.findIndex((moment) => moment.step === step);
      if (earlier >= 0) {
        steps.splice(earlier, 1);
      }
      steps.push({ step, at: Date.now() });
    },
  };
}
