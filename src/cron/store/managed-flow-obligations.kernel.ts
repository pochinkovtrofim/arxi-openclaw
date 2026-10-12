/** Durable managed-Flow Automation receipts bound to paced cron jobs; worker transaction only. */
import type { DatabaseSync } from "node:sqlite";
import {
  listTaskFlowAutomationObligationsForCronJobFromSqlite,
  transitionTaskFlowAutomationObligationPhaseInStateTransaction,
} from "../../tasks/task-flow-automation-obligation.store.sqlite.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import type { CronJob } from "../types.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";

export type CronManagedFlowRepairInput = { storeKey: string; jobIds: string[] };

export type CronManagedFlowRepairOutput = {
  changed: boolean;
  /** Earliest live receipt per job under its current schedule identity. */
  earliest: Array<{ jobId: string; scheduleIdentity: string; scheduledAtMs: number }>;
  invalidJobIds: string[];
};

export type CronManagedFlowConsumedRun = { jobId: string; startedAt: number };

/**
 * Reinstates only a missing or later timer slot from the persisted, already-paced
 * receipt. It never recomputes pacing, enables a job, or changes a paused scheduler.
 */
export function repairManagedFlowObligationsInDatabase(
  database: DatabaseSync,
  input: CronManagedFlowRepairInput,
): CronManagedFlowRepairOutput {
  const committed = mutateCronRuntimeRowsInDatabase({
    database,
    storeKey: input.storeKey,
    jobIds: new Set(input.jobIds),
    mutate: ({ jobs }) => {
      const upsertJobIds: string[] = [];
      const earliestByJob: CronManagedFlowRepairOutput["earliest"] = [];
      const invalidJobIds: string[] = [];
      for (const jobId of input.jobIds) {
        const job = jobs.get(jobId);
        const scheduleIdentity = job ? tryCronScheduleIdentity(job) : undefined;
        if (!job || !job.enabled || job.pacing === undefined || !scheduleIdentity) {
          continue;
        }
        let receipts;
        try {
          receipts = listTaskFlowAutomationObligationsForCronJobFromSqlite(database, {
            cronStoreKey: input.storeKey,
            cronJobId: job.id,
            phases: ["bound", "scheduled"],
          });
        } catch {
          invalidJobIds.push(job.id);
          continue;
        }
        const earliest = receipts.find((entry) => entry.cronScheduleIdentity === scheduleIdentity);
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
        if (!earliest) {
          continue;
        }
        earliestByJob.push({
          jobId: job.id,
          scheduleIdentity,
          scheduledAtMs: earliest.scheduledAtMs,
        });
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
      return {
        upsertJobIds,
        runHooks: false,
        value: { changed: upsertJobIds.length > 0, earliest: earliestByJob, invalidJobIds },
      };
    },
  });
  return committed.value;
}

/**
 * A scheduled receipt is one timer opportunity. Once that timer run reaches a
 * terminal outcome, suspend it unless the run itself atomically replaced it.
 */
export function suspendConsumedManagedFlowObligationsInDatabase(params: {
  database: DatabaseSync;
  storeKey: string;
  jobs: ReadonlyMap<string, CronJob>;
  consumed: readonly CronManagedFlowConsumedRun[];
}): void {
  for (const run of params.consumed) {
    const job = params.jobs.get(run.jobId);
    const scheduleIdentity = job ? tryCronScheduleIdentity(job) : undefined;
    if (!job || !scheduleIdentity) {
      continue;
    }
    let scheduled;
    try {
      scheduled = listTaskFlowAutomationObligationsForCronJobFromSqlite(params.database, {
        cronStoreKey: params.storeKey,
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
          : obligation.scheduledAtMs <= run.startedAt
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
