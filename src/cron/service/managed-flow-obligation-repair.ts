/** Restores durable managed-Flow Automation receipts into their exact paced cron job. */
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import { cronStoreKey } from "../store/key.js";
import type {
  CronManagedFlowConsumedRun,
  CronManagedFlowRepairOutput,
} from "../store/managed-flow-obligations.kernel.js";
import type { CronJob } from "../types.js";
import { isJobEnabled, isSuspendWakeDeferredJob } from "./jobs-scheduling.js";
import type { CronServiceState } from "./state.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";

type ObservedReceipts = {
  /** Schedule identity of every paced job the repair pass read, valid or not. */
  observed: Map<string, string>;
  invalidJobIds: Set<string>;
  earliest: Map<string, { scheduleIdentity: string; wakeAtMs: number }>;
};

// The suspend-wake snapshot is synchronous; it reads the last committed repair pass.
const earliestReceiptsByState = new WeakMap<CronServiceState, ObservedReceipts>();
// Finalized runs consumed receipts that no repair pass has re-read yet.
const repairDueStates = new WeakSet<CronServiceState>();

function pacedScheduleIdentity(job: CronJob): string | undefined {
  return job.enabled && job.pacing !== undefined ? tryCronScheduleIdentity(job) : undefined;
}

function isEligible(state: CronServiceState): boolean {
  return !state.stopped && !state.schedulingPaused && state.deps.cronEnabled;
}

/**
 * Restores missing/later slots and rebinds accepted triggers after cadence edits.
 * It never enables a job or changes a paused scheduler.
 * Returns true when job rows changed and the caller must reload the store.
 */
export async function repairManagedFlowAutomationObligations(
  state: CronServiceState,
): Promise<boolean> {
  if (!isEligible(state) || !state.store) {
    return false;
  }
  // One prompt pass per consumption: a failing pass falls back to the ordinary cadence.
  repairDueStates.delete(state);
  const storeKey = cronStoreKey(state.deps.storePath);
  const observed = new Map<string, string>();
  for (const job of state.store.jobs) {
    const scheduleIdentity = pacedScheduleIdentity(job);
    if (scheduleIdentity) {
      observed.set(job.id, scheduleIdentity);
    }
  }
  const jobIds = [...observed.keys()];
  if (jobIds.length === 0) {
    earliestReceiptsByState.set(state, {
      observed,
      invalidJobIds: new Set(),
      earliest: new Map(),
    });
    return false;
  }
  const context = captureOpenClawStateWorkerContext();
  const generation = state.lifecycleGeneration;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (
      cronStoreKey(state.deps.storePath) !== storeKey ||
      state.lifecycleGeneration !== generation
    ) {
      throw new Error("Cron managed-Flow repair source changed before commit");
    }
  };
  let result: CronManagedFlowRepairOutput;
  try {
    result = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "cron.repairManagedFlowObligations",
          input: { storeKey, jobIds, now: state.deps.nowMs() },
        }),
      {
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    );
  } catch (error) {
    earliestReceiptsByState.delete(state);
    throw error;
  }
  for (const jobId of result.invalidJobIds) {
    state.deps.log.warn(
      { jobId },
      "cron: managed Flow Automation receipt was invalid and was not scheduled",
    );
  }
  earliestReceiptsByState.set(state, {
    observed,
    invalidJobIds: new Set(result.invalidJobIds),
    earliest: new Map(
      result.earliest.map((entry) => [
        entry.jobId,
        { scheduleIdentity: entry.scheduleIdentity, wakeAtMs: entry.wakeAtMs },
      ]),
    ),
  });
  return result.changed;
}

/**
 * Earliest pending managed-Flow receipt across the given paced jobs. Due owner
 * work bound to a job whose own cadence never wakes a suspended host must still
 * become that host's wake deadline; a far receipt never shows in the job's slot
 * because repair only pulls a slot earlier. Throws until a repair pass has
 * observed the receipts committed since the last consumed run, and for a paced
 * job whose receipts that pass could not read cleanly. A job the pass did not
 * read at its current schedule (created or rescheduled since) is skipped: its
 * receipts join the next pass, and refusing it would keep a host awake until a
 * timer tick that may be hours away.
 */
export function earliestManagedFlowObligationAtMs(
  state: CronServiceState,
  jobs: readonly CronJob[],
): number | undefined {
  const receipts = earliestReceiptsByState.get(state);
  if (!receipts) {
    throw new Error("managed Flow receipts have not been observed since the last run");
  }
  let earliest: number | undefined;
  for (const job of jobs) {
    const scheduleIdentity = pacedScheduleIdentity(job);
    if (!scheduleIdentity) {
      continue;
    }
    if (receipts.observed.get(job.id) !== scheduleIdentity) {
      continue;
    }
    if (receipts.invalidJobIds.has(job.id)) {
      throw new Error(`managed Flow receipts for cron job ${job.id} are invalid`);
    }
    const receipt = receipts.earliest.get(job.id);
    if (!receipt || receipt.scheduleIdentity !== scheduleIdentity) {
      continue;
    }
    if (earliest === undefined || receipt.wakeAtMs < earliest) {
      earliest = receipt.wakeAtMs;
    }
  }
  return earliest;
}

/**
 * Whether the timer must run a repair pass soon. Until it does, the suspend
 * snapshot is incomplete and every suspension prepare refuses; prepare pauses
 * and re-arms the timer, so a minute-long delay would never elapse between
 * prepare retries and the host would stay awake.
 */
export function managedFlowRepairDue(state: CronServiceState): boolean {
  // Only deferred jobs make the snapshot read the receipts.
  return (
    repairDueStates.has(state) &&
    (state.store?.jobs.some((job) => isJobEnabled(job) && isSuspendWakeDeferredJob(job)) ?? false)
  );
}

/** Finalization consumes receipts; snapshots stay incomplete until the next repair pass. */
export function managedFlowConsumedRuns(
  state: CronServiceState,
  outcomes: readonly TimedCronRunOutcome[],
): CronManagedFlowConsumedRun[] {
  earliestReceiptsByState.delete(state);
  repairDueStates.add(state);
  return outcomes.map((outcome) => ({
    jobId: outcome.jobId,
    startedAt: outcome.startedAt,
    endedAt: outcome.endedAt,
    served: outcome.status === "ok" && outcome.triggerEval?.fired !== false,
  }));
}
