import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureTaskFlowAutomationObligationSchema } from "../../state/openclaw-state-db-schema-additive.js";
import {
  listTaskFlowAutomationObligationsForCronJobFromSqlite,
  transitionTaskFlowAutomationObligationPhaseInStateTransaction,
  upsertTaskFlowAutomationObligationInStateTransaction,
} from "../../tasks/task-flow-automation-obligation.store.sqlite.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { suspendConsumedManagedFlowAutomationObligations } from "./managed-flow-obligation-repair.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE flow_runs (
      flow_id TEXT PRIMARY KEY, sync_mode TEXT NOT NULL, owner_key TEXT NOT NULL,
      controller_id TEXT, revision INTEGER NOT NULL, status TEXT NOT NULL,
      ended_at INTEGER, cancel_requested_at INTEGER
    ) STRICT;
  `);
  ensureTaskFlowAutomationObligationSchema(db);
  return db;
}

function insertFlow(db: DatabaseSync, flowId: string, revision: number): void {
  db.prepare(
    `INSERT INTO flow_runs
      (flow_id, sync_mode, owner_key, controller_id, revision, status, ended_at, cancel_requested_at)
     VALUES (?, 'managed', 'agent:main:main', 'controller', ?, 'waiting', NULL, NULL)`,
  ).run(flowId, revision);
}

describe("managed Flow Automation obligation repair", () => {
  it("consumes every due bound or scheduled receipt once while preserving a later receipt", () => {
    const db = database();
    const storePath = "/tmp/managed-flow-obligation-test.json";
    const job = {
      id: "steward",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      pacing: { min: "15m", max: "24h" },
      state: {},
    } as CronJob;
    const scheduleIdentity = tryCronScheduleIdentity(job);
    if (!scheduleIdentity) throw new Error("expected valid schedule identity");
    const storeKey = cronStoreKey(storePath);
    for (const [flowId, revision, scheduledAtMs] of [
      ["flow-a", 3, 1_000],
      ["flow-b", 4, 1_500],
      ["flow-c", 5, 2_500],
    ] as const) {
      insertFlow(db, flowId, revision);
      upsertTaskFlowAutomationObligationInStateTransaction(db, {
        flowId,
        expectedFlowRevision: revision,
        controllerId: "controller",
        cronStoreKey: storeKey,
        cronJobId: job.id,
        cronScheduleIdentity: scheduleIdentity,
        sourceRunId: "timer-run",
        triggerAtMs: scheduledAtMs,
        scheduledAtMs,
        triggerKind: "next-check",
        triggerDigest: "a".repeat(64),
        now: 100,
      });
    }
    transitionTaskFlowAutomationObligationPhaseInStateTransaction(db, {
      flowId: "flow-a",
      expectedFlowRevision: 3,
      from: "bound",
      to: "scheduled",
    });
    suspendConsumedManagedFlowAutomationObligations({
      database: db,
      storePath,
      jobs: new Map([[job.id, job]]),
      outcomes: [{ jobId: job.id, startedAt: 2_000 } as TimedCronRunOutcome],
    });
    expect(
      listTaskFlowAutomationObligationsForCronJobFromSqlite(db, {
        cronStoreKey: storeKey,
        cronJobId: job.id,
      }).map((entry) => [entry.flowId, entry.phase]),
    ).toEqual([
      ["flow-a", "suspended"],
      ["flow-b", "suspended"],
      ["flow-c", "bound"],
    ]);
  });
});
