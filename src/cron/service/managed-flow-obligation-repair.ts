import {
  listTaskFlowAutomationObligationsForCronJobFromSqlite,
  transitionTaskFlowAutomationObligationPhaseInStateTransaction,
} from "../../tasks/task-flow-automation-obligation.store.sqlite.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
/** Restores durable managed-Flow Automation receipts into their exact paced cron job. */
import { cronStoreKey } from "../store/key.js";
import { commitCronRuntimeRows } from "./runtime-store.js";
import type { CronServiceState } from "./state.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";

function isEligible(state: CronServiceState): boolean {
  return !state.stopped && !state.schedulingPaused && state.deps.cronEnabled;
}

/**
 * Reinstates only a missing or later timer slot from the persisted, already-paced
 * receipt. It never recomputes pacing, enables a job, or changes a paused scheduler.
 */
export function repairManagedFlowAutomationObligations(state: CronServiceState): boolean {
  if (!isEligible(state) || !state.store) {
    return false;
  }
  const storeKey = cronStoreKey(state.deps.storePath);
  const eligibleJobIds = state.store.jobs
    .filter((job) => job.enabled && job.pacing !== undefined && tryCronScheduleIdentity(job))
    .map((job) => job.id);
  if (eligibleJobIds.length === 0) {
    return false;
  }
  return commitCronRuntimeRows({
    state,
    jobIds: eligibleJobIds,
    operationLabel: "cron.managed-flow-obligation-repair",
    mutate: ({ database, jobs }) => {
      const upsertJobIds: string[] = [];
      for (const jobId of eligibleJobIds) {
        const job = jobs.get(jobId);
        const scheduleIdentity = job ? tryCronScheduleIdentity(job) : undefined;
        if (!job || !job.enabled || job.pacing === undefined || !scheduleIdentity) {
          continue;
        }
        let receipts;
        try {
          receipts = listTaskFlowAutomationObligationsForCronJobFromSqlite(database, {
            cronStoreKey: storeKey,
            cronJobId: job.id,
            phases: ["bound", "scheduled"],
          });
        } catch (error) {
          state.deps.log.warn(
            { err: String(error), jobId: job.id },
            "cron: managed Flow Automation receipt was invalid and was not scheduled",
          );
          continue;
        }
        const currentReceipts = receipts.filter(
          (entry) => entry.cronScheduleIdentity === scheduleIdentity,
        );
        for (const stale of receipts) {
          if (stale.cronScheduleIdentity === scheduleIdentity) {
            continue;
          }
          transitionTaskFlowAutomationObligationPhaseInStateTransaction(database, {
            flowId: stale.flowId,
            expectedFlowRevision: stale.flowRevision,
            from: stale.phase,
            to: "blocked",
          });
        }
        const earliest = currentReceipts[0];
        if (!earliest) {
          continue;
        }
        const current = job.state.nextRunAtMs;
        if (
          current === undefined ||
          !Number.isSafeInteger(current) ||
          current > earliest.scheduledAtMs
        ) {
          job.state.nextRunAtMs = earliest.scheduledAtMs;
          job.state.pacedNextRunAtMs = earliest.scheduledAtMs;
          upsertJobIds.push(job.id);
        }
        if (earliest.phase === "bound") {
          transitionTaskFlowAutomationObligationPhaseInStateTransaction(database, {
            flowId: earliest.flowId,
            expectedFlowRevision: earliest.flowRevision,
            from: "bound",
            to: "scheduled",
          });
        }
      }
      return { upsertJobIds, value: upsertJobIds.length > 0 };
    },
  });
}

/**
 * A scheduled receipt is one timer opportunity. Once that timer run reaches a
 * terminal outcome, suspend it unless the run itself atomically replaced it.
 */
export function suspendConsumedManagedFlowAutomationObligations(params: {
  database: import("node:sqlite").DatabaseSync;
  storePath: string;
  jobs: ReadonlyMap<string, import("../types.js").CronJob>;
  outcomes: readonly TimedCronRunOutcome[];
}): void {
  const storeKey = cronStoreKey(params.storePath);
  for (const outcome of params.outcomes) {
    const job = params.jobs.get(outcome.jobId);
    const scheduleIdentity = job ? tryCronScheduleIdentity(job) : undefined;
    if (!job || !scheduleIdentity) {
      continue;
    }
    let scheduled;
    try {
      scheduled = listTaskFlowAutomationObligationsForCronJobFromSqlite(params.database, {
        cronStoreKey: storeKey,
        cronJobId: job.id,
        phases: ["bound", "scheduled"],
      });
    } catch {
      // Repair will retain the invalid row and report it on its next isolated pass;
      // a cron outcome must not turn one malformed opt-in receipt into cron-wide loss.
      continue;
    }
    for (const obligation of scheduled) {
      const phase =
        obligation.cronScheduleIdentity !== scheduleIdentity
          ? "blocked"
          : obligation.scheduledAtMs <= outcome.startedAt
            ? "suspended"
            : undefined;
      if (!phase) {
        continue;
      }
      transitionTaskFlowAutomationObligationPhaseInStateTransaction(params.database, {
        flowId: obligation.flowId,
        expectedFlowRevision: obligation.flowRevision,
        from: obligation.phase,
        to: phase,
      });
    }
  }
}
