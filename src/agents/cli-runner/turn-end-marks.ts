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
