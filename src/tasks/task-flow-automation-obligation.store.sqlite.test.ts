import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureTaskFlowAutomationObligationSchema } from "../state/openclaw-state-db-schema-additive.js";
import {
  findEarliestTaskFlowAutomationObligationForCronJobFromSqlite,
  listTaskFlowAutomationObligationsForCronJobFromSqlite,
  removeTaskFlowAutomationObligationForTerminalFlowInStateTransaction,
  transitionTaskFlowAutomationObligationPhaseInStateTransaction,
  upsertTaskFlowAutomationObligationInStateTransaction,
} from "./task-flow-automation-obligation.store.sqlite.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database(options: { obligationSchema?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE flow_runs (
      flow_id TEXT PRIMARY KEY, sync_mode TEXT NOT NULL, owner_key TEXT NOT NULL,
      controller_id TEXT, revision INTEGER NOT NULL, status TEXT NOT NULL,
      ended_at INTEGER, cancel_requested_at INTEGER
    ) STRICT;
  `);
  if (options.obligationSchema !== false) ensureTaskFlowAutomationObligationSchema(db);
  return db;
}

function insertFlow(db: DatabaseSync, values: Partial<Record<string, unknown>> = {}) {
  db.prepare(
    `INSERT INTO flow_runs
      (flow_id, sync_mode, owner_key, controller_id, revision, status, ended_at, cancel_requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.flow_id ?? "flow-a",
    values.sync_mode ?? "managed",
    values.owner_key ?? "owner-a",
    values.controller_id ?? "controller-a",
    values.revision ?? 3,
    values.status ?? "waiting",
    values.ended_at ?? null,
    values.cancel_requested_at ?? null,
  );
}

function obligation(
  overrides: Partial<
    Parameters<typeof upsertTaskFlowAutomationObligationInStateTransaction>[1]
  > = {},
) {
  return {
    flowId: "flow-a",
    expectedFlowRevision: 3,
    controllerId: "controller-a",
    cronStoreKey: "owner-a:arxi",
    cronJobId: "steward",
    cronScheduleIdentity: "paced:daily",
    sourceRunId: "run-1",
    triggerAtMs: 2_000,
    scheduledAtMs: 2_000,
    triggerKind: "next-check",
    triggerDigest: "a".repeat(64),
    now: 1_000,
    ...overrides,
  };
}

describe("Task Flow Automation obligation store", () => {
  it("binds a live managed controller Flow without duplicating its owner", () => {
    const db = database();
    insertFlow(db);
    const saved = upsertTaskFlowAutomationObligationInStateTransaction(db, obligation());

    expect(saved).toMatchObject({
      flowId: "flow-a",
      controllerId: "controller-a",
      flowRevision: 3,
      phase: "bound",
      createdAtMs: 1_000,
    });
    expect(saved.obligationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(
      db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("task_flow_automation_obligations"),
    ).not.toMatchObject({ sql: expect.stringContaining("owner_key") });
  });

  it("CAS-replaces one Flow receipt and selects only the earliest persisted paced receipt for its job", () => {
    const db = database();
    insertFlow(db);
    insertFlow(db, { flow_id: "flow-b", revision: 4 });
    const first = upsertTaskFlowAutomationObligationInStateTransaction(
      db,
      obligation({
        triggerAtMs: 1_500,
        scheduledAtMs: 5_000,
      }),
    );
    const replacement = upsertTaskFlowAutomationObligationInStateTransaction(
      db,
      obligation({
        flowId: "flow-a",
        triggerAtMs: 1_600,
        scheduledAtMs: 4_000,
        sourceRunId: "run-2",
        now: 1_100,
      }),
    );
    expect(replacement.obligationId).toBe(first.obligationId);
    upsertTaskFlowAutomationObligationInStateTransaction(
      db,
      obligation({
        flowId: "flow-b",
        expectedFlowRevision: 4,
        triggerAtMs: 3_000,
        scheduledAtMs: 2_000,
        now: 1_200,
      }),
    );

    expect(
      findEarliestTaskFlowAutomationObligationForCronJobFromSqlite(db, {
        cronStoreKey: "owner-a:arxi",
        cronJobId: "steward",
      })?.flowId,
    ).toBe("flow-b");
    expect(
      listTaskFlowAutomationObligationsForCronJobFromSqlite(db, {
        cronStoreKey: "owner-a:arxi",
        cronJobId: "steward",
      }),
    ).toHaveLength(2);
    expect(
      transitionTaskFlowAutomationObligationPhaseInStateTransaction(db, {
        flowId: "flow-b",
        expectedFlowRevision: 4,
        from: "bound",
        to: "scheduled",
        now: 1_300,
      }),
    ).toBe(true);
    expect(
      findEarliestTaskFlowAutomationObligationForCronJobFromSqlite(db, {
        cronStoreKey: "owner-a:arxi",
        cronJobId: "steward",
      })?.flowId,
    ).toBe("flow-a");
  });

  it("rejects stale, foreign, terminal, and mirrored Flow writes without changing an existing receipt", () => {
    const db = database();
    insertFlow(db);
    upsertTaskFlowAutomationObligationInStateTransaction(db, obligation());
    db.prepare("UPDATE flow_runs SET revision = ? WHERE flow_id = ?").run(4, "flow-a");
    expect(
      listTaskFlowAutomationObligationsForCronJobFromSqlite(db, {
        cronStoreKey: "owner-a:arxi",
        cronJobId: "steward",
      }),
    ).toHaveLength(1);
    for (const override of [{ expectedFlowRevision: 2 }, { controllerId: "controller-b" }]) {
      expect(() =>
        upsertTaskFlowAutomationObligationInStateTransaction(db, obligation(override)),
      ).toThrow();
    }
    db.prepare("UPDATE flow_runs SET status = 'succeeded', ended_at = ? WHERE flow_id = ?").run(
      2_000,
      "flow-a",
    );
    expect(() =>
      upsertTaskFlowAutomationObligationInStateTransaction(
        db,
        obligation({ expectedFlowRevision: 4 }),
      ),
    ).toThrow();
    expect(
      listTaskFlowAutomationObligationsForCronJobFromSqlite(db, {
        cronStoreKey: "owner-a:arxi",
        cronJobId: "steward",
      }),
    ).toHaveLength(0);
  });

  it("rejects unbounded trigger metadata before it can enter the durable receipt", () => {
    const db = database();
    insertFlow(db);
    expect(() =>
      upsertTaskFlowAutomationObligationInStateTransaction(
        db,
        obligation({ triggerKind: "x".repeat(257) }),
      ),
    ).toThrow("trigger kind");
    expect(() =>
      upsertTaskFlowAutomationObligationInStateTransaction(
        db,
        obligation({ triggerDigest: "not-a-sha256" }),
      ),
    ).toThrow("trigger digest");
    expect(
      listTaskFlowAutomationObligationsForCronJobFromSqlite(db, {
        cronStoreKey: "owner-a:arxi",
        cronJobId: "steward",
      }),
    ).toEqual([]);
  });

  it("removes only a terminal Flow receipt and refuses premature deletion", () => {
    const db = database();
    insertFlow(db);
    insertFlow(db, { flow_id: "flow-b", revision: 4 });
    upsertTaskFlowAutomationObligationInStateTransaction(db, obligation());
    upsertTaskFlowAutomationObligationInStateTransaction(
      db,
      obligation({ flowId: "flow-b", expectedFlowRevision: 4 }),
    );

    expect(() =>
      removeTaskFlowAutomationObligationForTerminalFlowInStateTransaction(db, {
        flowId: "flow-a",
        expectedFlowRevision: 3,
        controllerId: "controller-a",
      }),
    ).toThrow("requires a terminal flow");
    db.prepare("UPDATE flow_runs SET status = 'cancelled', ended_at = ? WHERE flow_id = ?").run(
      2_000,
      "flow-a",
    );
    expect(
      removeTaskFlowAutomationObligationForTerminalFlowInStateTransaction(db, {
        flowId: "flow-a",
        expectedFlowRevision: 3,
        controllerId: "controller-a",
      }),
    ).toBe(true);
    expect(
      listTaskFlowAutomationObligationsForCronJobFromSqlite(db, {
        cronStoreKey: "owner-a:arxi",
        cronJobId: "steward",
      }).map((entry) => entry.flowId),
    ).toEqual(["flow-b"]);
  });

  it("does not create an opt-in table while terminalizing an unbound Flow", () => {
    const db = database({ obligationSchema: false });
    insertFlow(db, { status: "succeeded", ended_at: 2_000 });
    expect(
      removeTaskFlowAutomationObligationForTerminalFlowInStateTransaction(db, {
        flowId: "flow-a",
        expectedFlowRevision: 3,
        controllerId: "controller-a",
      }),
    ).toBe(false);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
        .get("task_flow_automation_obligations"),
    ).toBeUndefined();
  });
});
