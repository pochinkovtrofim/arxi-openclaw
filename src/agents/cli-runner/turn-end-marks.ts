/**
 * When each CLI run's model turn ended, so the run can report the time it spent
 * after the turn (the CLI writing its result, settlement, cleanup) as its own
 * stage. Keyed by run id; the run takes its mark once. Bounded so an abandoned run
 * cannot grow the map.
 */
const MAX_MARKS = 256;
const turnEnds = new Map<string, number>();

export function noteCliTurnEnded(runId: string, at: number): void {
  turnEnds.delete(runId);
  turnEnds.set(runId, at);
  while (turnEnds.size > MAX_MARKS) {
    const oldest = turnEnds.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    turnEnds.delete(oldest);
  }
}

export function takeCliTurnEnd(runId: string): number | undefined {
  const at = turnEnds.get(runId);
  turnEnds.delete(runId);
  return at;
}

export function clearCliTurnEnd(runId: string): void {
  turnEnds.delete(runId);
  settleSteps.delete(runId);
}

/** Settlement steps after a run's model turn, each reported as its own stage. */
export type CliSettleStep = "resolve" | "backend-release" | "live-close" | "mcp-retire" | "auth-profile";

const settleSteps = new Map<string, Array<{ step: CliSettleStep; at: number }>>();

/** Marks the end of one settlement step of a run. */
export function noteCliSettleStep(runId: string, step: CliSettleStep, at = Date.now()): void {
  let steps = settleSteps.get(runId);
  if (!steps) {
    steps = [];
    settleSteps.set(runId, steps);
    while (settleSteps.size > MAX_MARKS) {
      const oldest = settleSteps.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      settleSteps.delete(oldest);
    }
  }
  steps.push({ step, at });
}

export function takeCliSettleSteps(runId: string): Array<{ step: CliSettleStep; at: number }> {
  const steps = settleSteps.get(runId) ?? [];
  settleSteps.delete(runId);
  return steps;
}
