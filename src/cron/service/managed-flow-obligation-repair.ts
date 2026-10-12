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
import type { CronServiceState } from "./state.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";

type ObservedReceipts = {
  /** Schedule identity of every paced job the repair pass read, valid or not. */
  observed: Map<string, string>;
  invalidJobIds: Set<string>;
  earliest: Map<string, { scheduleIdentity: string; scheduledAtMs: number }>;
};

// The suspend-wake snapshot is synchronous; it reads the last committed repair pass.
const earliestReceiptsByState = new WeakMap<CronServiceState, ObservedReceipts>();

function pacedScheduleIdentity(job: CronJob): string | undefined {
  return job.enabled && job.pacing !== undefined ? tryCronScheduleIdentity(job) : undefined;
}

function isEligible(state: CronServiceState): boolean {
  return !state.stopped && !state.schedulingPaused && state.deps.cronEnabled;
}

/**
 * Reinstates only a missing or later timer slot from the persisted, already-paced
 * receipt. It never recomputes pacing, enables a job, or changes a paused scheduler.
 * Returns true when job rows changed and the caller must reload the store.
 */
export async function repairManagedFlowAutomationObligations(
  state: CronServiceState,
): Promise<boolean> {
  if (!isEligible(state) || !state.store) {
    return false;
  }
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
          input: { storeKey, jobIds },
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
        { scheduleIdentity: entry.scheduleIdentity, scheduledAtMs: entry.scheduledAtMs },
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
 * observed the receipts committed since the last consumed run, and for any paced
 * job that pass did not read at its current schedule or could not read cleanly.
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
      throw new Error(`managed Flow receipts for cron job ${job.id} have not been observed`);
    }
    if (receipts.invalidJobIds.has(job.id)) {
      throw new Error(`managed Flow receipts for cron job ${job.id} are invalid`);
    }
    const receipt = receipts.earliest.get(job.id);
    if (!receipt || receipt.scheduleIdentity !== scheduleIdentity) {
      continue;
    }
    if (earliest === undefined || receipt.scheduledAtMs < earliest) {
      earliest = receipt.scheduledAtMs;
    }
  }
  return earliest;
}

/** Finalization consumes receipts; snapshots stay incomplete until the next repair pass. */
export function managedFlowConsumedRuns(
  state: CronServiceState,
  outcomes: readonly TimedCronRunOutcome[],
): CronManagedFlowConsumedRun[] {
  earliestReceiptsByState.delete(state);
  return outcomes.map((outcome) => ({ jobId: outcome.jobId, startedAt: outcome.startedAt }));
}
