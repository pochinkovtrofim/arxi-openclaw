// In-process snapshot invalidation only; the database remains the receipt authority.
// Worker finalization invalidates through managedFlowConsumedRuns. Foreground
// mutations use this epoch so suspension cannot reuse a stale wake snapshot.
let epoch = 0;

export function invalidateManagedFlowObligationSnapshots(): void {
  epoch += 1;
}

export function managedFlowObligationSnapshotEpoch(): number {
  return epoch;
}
