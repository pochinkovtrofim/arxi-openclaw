/** Durable managed-Flow Automation receipts bound to paced cron jobs; worker transaction only. */
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listTaskFlowAutomationObligationsForCronJobFromSqlite,
  transitionTaskFlowAutomationObligationPhaseInStateTransaction,
  rescheduleTaskFlowAutomationObligationInStateTransaction,
} from "../../tasks/task-flow-automation-obligation.store.sqlite.js";
import { resolvePacedNextRunAtMs } from "../pacing.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import type { CronJob } from "../types.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";

export type CronManagedFlowRepairInput = { storeKey: string; jobIds: string[]; now: number };

export type CronManagedFlowRepairOutput = {
  changed: boolean;
  /** Earliest live receipt per job under its current schedule identity. */
  earliest: Array<{
    jobId: string;
    scheduleIdentity: string;
    scheduledAtMs: number;
    wakeAtMs: number;
  }>;
  invalidJobIds: string[];
};

export type CronManagedFlowConsumedRun = {
  jobId: string;
  startedAt: number;
  endedAt?: number;
  served?: boolean;
};

// Changing an enabled interval's cadence does not revoke the Flow's accepted
// trigger. Other identity changes still block the receipt until explicit repair.
function cadenceOnlyChange(previous: string, current: string): boolean {
  try {
    const before: unknown = JSON.parse(previous),
      after: unknown = JSON.parse(current);
    if (
      !isRecord(before) ||
      !isRecord(after) ||
      before.enabled !== true ||
      after.enabled !== true ||
      !isRecord(before.schedule) ||
      !isRecord(after.schedule) ||
      before.schedule.kind !== "every" ||
      after.schedule.kind !== "every"
    ) {
      return false;
    }
    return (
      JSON.stringify({ ...before, schedule: after.schedule, pacing: after.pacing }) === current
    );
  } catch {
    return false;
  }
}

/**
 * Restores missing/later slots and rebinds accepted triggers after cadence edits.
 * It never enables a job or changes a paused scheduler.
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
        const live = [];
        for (const receipt of receipts) {
          if (receipt.cronScheduleIdentity === scheduleIdentity) {
            live.push(receipt);
            continue;
          }
          if (cadenceOnlyChange(receipt.cronScheduleIdentity, scheduleIdentity)) {
            const now = input.now;
            const scheduledAtMs = resolvePacedNextRunAtMs({
              nowMs: now,
              delayMs: receipt.triggerAtMs - now,
              pacing: job.pacing,
            });
            if (scheduledAtMs !== undefined) {
              rescheduleTaskFlowAutomationObligationInStateTransaction(database, {
                flowId: receipt.flowId,
                expectedFlowRevision: receipt.flowRevision,
                from: receipt.phase,
                scheduledAtMs,
                now,
                scheduleIdentity,
              });
              live.push({ ...receipt, cronScheduleIdentity: scheduleIdentity, scheduledAtMs });
              continue;
            }
          }
          transitionTaskFlowAutomationObligationPhaseInStateTransaction(database, {
            flowId: receipt.flowId,
            expectedFlowRevision: receipt.flowRevision,
            from: receipt.phase,
            to: "blocked",
          });
        }
        const earliest = live.toSorted((a, b) => a.scheduledAtMs - b.scheduledAtMs)[0];
        if (!earliest) {
          continue;
        }
        earliestByJob.push({
          jobId: job.id,
          scheduleIdentity,
          scheduledAtMs: earliest.scheduledAtMs,
          // The paced slot may be hours before the actual accepted trigger.
          // After a failed due run the refreshed slot supplies retry backoff.
          wakeAtMs: Math.min(
            ...live.map((entry) => Math.max(entry.triggerAtMs, entry.scheduledAtMs)),
          ),
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
 * An early paced check does not consume a future trigger. Keep the obligation
 * and advance its slot until a due run succeeds or replaces it atomically.
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
      const changedCadence = obligation.cronScheduleIdentity !== scheduleIdentity &&
        cadenceOnlyChange(obligation.cronScheduleIdentity, scheduleIdentity);
      const phase =
        obligation.cronScheduleIdentity !== scheduleIdentity && !changedCadence
          ? "blocked"
          : obligation.triggerAtMs <= run.startedAt && run.served !== false
            ? "suspended"
            : undefined;
      if (!phase) {
        if (job.pacing && (changedCadence || obligation.scheduledAtMs <= run.startedAt)) {
          const now = run.endedAt ?? run.startedAt;
          const scheduledAtMs = resolvePacedNextRunAtMs({
            nowMs: now,
            delayMs: obligation.triggerAtMs - now,
            pacing: job.pacing,
          });
          if (scheduledAtMs !== undefined) {
            rescheduleTaskFlowAutomationObligationInStateTransaction(params.database, {
              flowId: obligation.flowId,
              expectedFlowRevision: obligation.flowRevision,
              from: obligation.phase,
              scheduledAtMs,
              now,
              ...(changedCadence ? { scheduleIdentity } : {}),
            });
          }
        }
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
