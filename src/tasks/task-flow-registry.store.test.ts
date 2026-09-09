// Covers task-flow registry store persistence, events, and state queries.
import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createRuntimeTaskFlow } from "../plugins/runtime/runtime-taskflow.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  deleteTaskFlowRecordById,
  getTaskFlowById,
  requestFlowCancel,
  setFlowWaiting,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import {
  bindTaskFlowExecution,
  listTaskFlowHistoryForOwnerFromSqlite,
  loadTaskFlowRegistryStateFromSqlite,
  loadTaskFlowRegistryStateFromSqliteReadOnly,
  pruneTaskFlowHistoryFromSqlite,
  saveTaskFlowRegistryStateToSqlite,
} from "./task-flow-registry.store.sqlite.js";
import {
  parseOptionalTaskFlowSyncMode,
  parseTaskFlowStatus,
  type TaskFlowRecord,
} from "./task-flow-registry.types.js";
import { parseTaskNotifyPolicy } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
} from "./task-runtime.test-helpers.js";

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

type TaskFlowRegistryTestDatabase = Pick<OpenClawStateKyselyDatabase, "flow_runs">;

function createStoredFlow(): TaskFlowRecord {
  return {
    flowId: "flow-restored",
    syncMode: "managed",
    ownerKey: "agent:main:main",
    controllerId: "tests/restored-controller",
    revision: 4,
    status: "blocked",
    notifyPolicy: "done_only",
    goal: "Restored flow",
    currentStep: "spawn_task",
    blockedTaskId: "task-restored",
    blockedSummary: "Writable session required.",
    stateJson: { lane: "triage", done: 3 },
    waitJson: { kind: "task", taskId: "task-restored" },
    cancelRequestedAt: 115,
    createdAt: 100,
    updatedAt: 120,
    endedAt: 120,
  };
}

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-store-",
    },
    async (state) => {
      const root = state.stateDir;
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        return await run(root);
      } finally {
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function restoreOriginalStateDir(): void {
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
}

describe("task-flow-registry store runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreOriginalStateDir();
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("does not create shared state for a read-only flow snapshot", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-flow-store-readonly-" },
      async (state) => {
        process.env.OPENCLAW_STATE_DIR = state.stateDir;
        resetTaskFlowRegistryForTests({ persist: false });
        const statePath = resolveOpenClawStateSqlitePath();
        expect(() => statSync(statePath)).toThrow();

        expect(loadTaskFlowRegistryStateFromSqliteReadOnly().flows.size).toBe(0);
        expect(() => statSync(statePath)).toThrow();
      },
    );
  });

  it("uses the configured flow store for restore and save", () => {
    const storedFlow = createStoredFlow();
    const loadSnapshot = vi.fn(() => ({
      flows: new Map([[storedFlow.flowId, storedFlow]]),
    }));
    const saveSnapshot = vi.fn();
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    const restored = getTaskFlowById("flow-restored");
    expect(restored?.flowId).toBe("flow-restored");
    expect(restored?.syncMode).toBe("managed");
    expect(restored?.controllerId).toBe("tests/restored-controller");
    expect(restored?.revision).toBe(4);
    expect(restored?.stateJson).toEqual({ lane: "triage", done: 3 });
    expect(restored?.waitJson).toEqual({ kind: "task", taskId: "task-restored" });
    expect(restored?.cancelRequestedAt).toBe(115);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/new-flow",
      goal: "New flow",
      status: "running",
      currentStep: "wait_for",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestCall = saveSnapshot.mock.calls[saveSnapshot.mock.calls.length - 1];
    if (!latestCall) {
      throw new Error("Expected task flow snapshot save call");
    }
    const latestSnapshot = latestCall[0] as {
      flows: ReadonlyMap<string, TaskFlowRecord>;
    };
    expect(latestSnapshot.flows.size).toBe(2);
    const restoredFlow = latestSnapshot.flows.get("flow-restored");
    if (!restoredFlow) {
      throw new Error("Expected restored task flow");
    }
    expect(restoredFlow.goal).toBe("Restored flow");
  });

  it("rejects invalid persisted flow enum values", () => {
    expect(parseOptionalTaskFlowSyncMode("managed")).toBe("managed");
    expect(parseOptionalTaskFlowSyncMode(null)).toBeUndefined();
    expect(parseTaskFlowStatus("waiting")).toBe("waiting");
    expect(parseTaskNotifyPolicy("state_changes")).toBe("state_changes");

    expect(() => parseOptionalTaskFlowSyncMode("legacy")).toThrow(
      "Invalid persisted task flow sync mode",
    );
    expect(() => parseTaskFlowStatus("done")).toThrow("Invalid persisted task flow status");
    expect(() => parseTaskNotifyPolicy("verbose")).toThrow("Invalid persisted task notify policy");
  });

  it("rejects corrupt persisted flow rows during sqlite restore", async () => {
    await withFlowRegistryTempDir(async () => {
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/corrupt-flow",
        goal: "Corrupt flow",
        status: "running",
      });

      const database = openOpenClawStateDatabase();
      const db = getNodeSqliteKysely<TaskFlowRegistryTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.updateTable("flow_runs").set({ status: "done" }).where("flow_id", "=", created.flowId),
      );

      expect(() => loadTaskFlowRegistryStateFromSqlite()).toThrow(
        "Invalid persisted task flow status",
      );
    });
  });

  it("drops invalid requester origins during sqlite restore", async () => {
    await withFlowRegistryTempDir(async () => {
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/invalid-origin-flow",
        goal: "Invalid origin flow",
        requesterOrigin: {
          channel: "test-channel",
          to: "C1234567890",
        },
      });

      const database = openOpenClawStateDatabase();
      const db = getNodeSqliteKysely<TaskFlowRegistryTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("flow_runs")
          .set({ requester_origin_json: '{"channel":42}' })
          .where("flow_id", "=", created.flowId),
      );

      const restored = loadTaskFlowRegistryStateFromSqlite();
      expect(restored.flows.get(created.flowId)?.requesterOrigin).toBeUndefined();
    });
  });

  it("restores persisted wait-state, revision, and cancel intent from sqlite", async () => {
    await withFlowRegistryTempDir(async () => {
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/persisted-flow",
        goal: "Persisted flow",
        status: "running",
        currentStep: "spawn_task",
        stateJson: { phase: "spawn" },
      });
      const waiting = setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: created.revision,
        currentStep: "ask_user",
        stateJson: { phase: "ask_user" },
        waitJson: { kind: "external_event", topic: "forum" },
      });
      expect(waiting.applied).toBe(true);
      if (!waiting.applied) {
        throw new Error("Expected wait state update to apply");
      }
      const cancelRequested = requestFlowCancel({
        flowId: created.flowId,
        expectedRevision: waiting.flow.revision,
        cancelRequestedAt: 444,
      });
      expect(cancelRequested.applied).toBe(true);

      resetTaskFlowRegistryForTests({ persist: false });

      const restored = getTaskFlowById(created.flowId);
      expect(restored?.flowId).toBe(created.flowId);
      expect(restored?.syncMode).toBe("managed");
      expect(restored?.controllerId).toBe("tests/persisted-flow");
      expect(restored?.revision).toBe(2);
      expect(restored?.status).toBe("waiting");
      expect(restored?.currentStep).toBe("ask_user");
      expect(restored?.stateJson).toEqual({ phase: "ask_user" });
      expect(restored?.waitJson).toEqual({ kind: "external_event", topic: "forum" });
      expect(restored?.cancelRequestedAt).toBe(444);
    });
  });

  it("round-trips explicit json null through sqlite", async () => {
    await withFlowRegistryTempDir(async () => {
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/null-roundtrip",
        goal: "Persist null payloads",
        stateJson: null,
        waitJson: null,
      });

      resetTaskFlowRegistryForTests({ persist: false });

      const restored = getTaskFlowById(created.flowId);
      expect(restored?.flowId).toBe(created.flowId);
      expect(restored?.stateJson).toBeNull();
      expect(restored?.waitJson).toBeNull();
    });
  });

  it("prunes large sqlite snapshots without binding every flow id at once", async () => {
    await withFlowRegistryTempDir(async () => {
      const flows = new Map<string, TaskFlowRecord>();
      for (let index = 0; index < 1_200; index++) {
        const flow: TaskFlowRecord = {
          ...createStoredFlow(),
          flowId: `flow-large-${index}`,
          controllerId: `tests/large-flow-${index}`,
          status: "running",
          createdAt: index,
          updatedAt: index,
          cancelRequestedAt: undefined,
          endedAt: undefined,
        };
        flows.set(flow.flowId, flow);
      }

      saveTaskFlowRegistryStateToSqlite({ flows });
      const admitted: AdmittedRunContext = {
        operationalRunInstance: { instanceId: "instance-flow-prune", runId: "run-flow-prune" },
        executionIdentityToken: createExecutionIdentityAdmissionToken("run-flow-prune", {
          contextId: "context-flow-prune",
          executionId: "execution-flow-prune",
        }),
      };
      expect(bindTaskFlowExecution({ admitted, flowId: "flow-large-0" })).toBe("bound");
      expect(bindTaskFlowExecution({ admitted, flowId: "flow-large-1199" })).toBe("bound");
      const retainedFlows = new Map([...flows].slice(100));
      saveTaskFlowRegistryStateToSqlite({ flows: retainedFlows });

      const restored = loadTaskFlowRegistryStateFromSqlite();
      expect(restored.flows.size).toBe(1_100);
      expect(restored.flows.has("flow-large-0")).toBe(false);
      expect(restored.flows.has("flow-large-1199")).toBe(true);
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            `SELECT owner_id
             FROM execution_owner_lifecycle_bindings
             WHERE owner_kind = 'flow'
             ORDER BY owner_id`,
          )
          .all(),
      ).toEqual([{ owner_id: "flow-large-1199" }]);
    });
  });

  it("binds only source-live flow owners across managed and mirrored lifecycles", async () => {
    await withFlowRegistryTempDir(async () => {
      const managed: TaskFlowRecord = {
        ...createStoredFlow(),
        flowId: "flow-binding-managed",
        status: "blocked",
        endedAt: undefined,
        cancelRequestedAt: undefined,
      };
      const mirrored: TaskFlowRecord = {
        ...createStoredFlow(),
        flowId: "flow-binding-mirrored",
        syncMode: "task_mirrored",
        controllerId: undefined,
        status: "running",
        endedAt: undefined,
        cancelRequestedAt: undefined,
      };
      const managedTerminal: TaskFlowRecord = {
        ...managed,
        flowId: "flow-binding-managed-terminal",
        status: "succeeded",
        endedAt: 200,
      };
      const mirroredTerminal: TaskFlowRecord = {
        ...mirrored,
        flowId: "flow-binding-mirrored-terminal",
        status: "blocked",
        endedAt: 201,
      };
      const managedCancelling: TaskFlowRecord = {
        ...managed,
        flowId: "flow-binding-managed-cancelling",
        status: "running",
        cancelRequestedAt: 199,
      };
      saveTaskFlowRegistryStateToSqlite({
        flows: new Map(
          [managed, mirrored, managedTerminal, mirroredTerminal, managedCancelling].map((flow) => [
            flow.flowId,
            flow,
          ]),
        ),
      });
      const admitted: AdmittedRunContext = {
        operationalRunInstance: { instanceId: "instance-flow-owner", runId: "run-flow-owner" },
        executionIdentityToken: createExecutionIdentityAdmissionToken("run-flow-owner", {
          contextId: "context-flow-owner",
          executionId: "execution-flow-owner",
        }),
      };

      expect(
        tableExists(openOpenClawStateDatabase().db, "execution_owner_lifecycle_bindings"),
      ).toBe(false);
      expect(bindTaskFlowExecution({ admitted, flowId: managedTerminal.flowId })).toBe("missing");
      expect(bindTaskFlowExecution({ admitted, flowId: mirroredTerminal.flowId })).toBe("missing");
      expect(bindTaskFlowExecution({ admitted, flowId: managedCancelling.flowId })).toBe("missing");
      expect(
        tableExists(openOpenClawStateDatabase().db, "execution_owner_lifecycle_bindings"),
      ).toBe(false);
      expect(bindTaskFlowExecution({ admitted, flowId: managed.flowId })).toBe("bound");
      expect(bindTaskFlowExecution({ admitted, flowId: mirrored.flowId })).toBe("bound");

      saveTaskFlowRegistryStateToSqlite({
        flows: new Map([
          [managed.flowId, { ...managed, status: "succeeded", endedAt: 210 }],
          [mirrored.flowId, { ...mirrored, status: "blocked", endedAt: 211 }],
          [managedTerminal.flowId, managedTerminal],
          [mirroredTerminal.flowId, mirroredTerminal],
          [managedCancelling.flowId, managedCancelling],
        ]),
      });
      expect(bindTaskFlowExecution({ admitted, flowId: managed.flowId })).toBe("missing");
      expect(bindTaskFlowExecution({ admitted, flowId: mirrored.flowId })).toBe("missing");
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            `SELECT owner_id
             FROM execution_owner_lifecycle_bindings
             WHERE owner_kind = 'flow'
             ORDER BY owner_id`,
          )
          .all(),
      ).toEqual([{ owner_id: managed.flowId }, { owner_id: mirrored.flowId }]);
    });
  });

  it("hardens the sqlite flow store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withFlowRegistryTempDir(async () => {
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/secured-flow",
        goal: "Secured flow",
        status: "blocked",
        blockedTaskId: "task-secured",
        blockedSummary: "Need auth.",
        waitJson: { kind: "task", taskId: "task-secured" },
      });

      const databasePath = resolveOpenClawStateSqlitePath(process.env);
      const registryDir = path.dirname(databasePath);
      expect(databasePath.endsWith(path.join("state", "openclaw.sqlite"))).toBe(true);
      expect(statSync(registryDir).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    });
  });

  it("keeps opted-in transition history atomic, owner-scoped, and independent of Flow GC", async () => {
    await withFlowRegistryTempDir(async () => {
      const controllerId = "tests/history";
      const ownerKey = "agent:owner:history";
      const createdAt = Date.now();
      const created = createManagedTaskFlow({
        ownerKey,
        controllerId,
        history: { controllerId },
        goal: "Retain this transition",
        status: "running",
        stateJson: { stage: "created" },
        createdAt,
        updatedAt: createdAt,
      });

      expect(
        updateFlowRecordByIdExpectedRevision({
          flowId: created.flowId,
          expectedRevision: 0,
          patch: {
            status: "succeeded",
            stateJson: { stage: "finished" },
            endedAt: createdAt,
            updatedAt: createdAt,
          },
        }),
      ).toMatchObject({ applied: true });
      const beforeGc = listTaskFlowHistoryForOwnerFromSqlite({ ownerKey, controllerId });
      expect(beforeGc.events).toHaveLength(2);
      expect(beforeGc.events.map((event) => event.revision)).toEqual([1, 0]);
      expect(beforeGc.events[0]?.snapshot.stateJson).toEqual({ stage: "finished" });
      expect(
        listTaskFlowHistoryForOwnerFromSqlite({
          ownerKey: "agent:other:history",
          controllerId,
        }).events,
      ).toEqual([]);
      expect(deleteTaskFlowRecordById(created.flowId)).toBe(true);
      expect(getTaskFlowById(created.flowId)).toBeUndefined();
      expect(listTaskFlowHistoryForOwnerFromSqlite({ ownerKey, controllerId }).events).toHaveLength(
        2,
      );

      expect(pruneTaskFlowHistoryFromSqlite(Date.now() + 91 * 24 * 60 * 60_000)).toBe(2);
      const afterRetention = listTaskFlowHistoryForOwnerFromSqlite({ ownerKey, controllerId });
      expect(afterRetention.events).toEqual([]);
      expect(afterRetention.archives).toEqual([]);
      expect(afterRetention.nextCursor).toEqual(expect.any(String));
      const archived = listTaskFlowHistoryForOwnerFromSqlite({
        ownerKey,
        controllerId,
        cursor: afterRetention.nextCursor,
      });
      expect(archived.archives).toMatchObject([
        {
          flowId: created.flowId,
          firstRevision: 0,
          lastRevision: 1,
          eventCount: 2,
        },
      ]);
      expect(archived.archives[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("rolls back the Flow update when its history receipt cannot be written", async () => {
    await withFlowRegistryTempDir(async () => {
      const controllerId = "tests/history-rollback";
      const created = createManagedTaskFlow({
        ownerKey: "agent:owner:rollback",
        controllerId,
        history: { controllerId },
        goal: "Atomic transition",
      });
      openOpenClawStateDatabase().db.exec(`
        CREATE TRIGGER task_flow_history_fail_before_insert
        BEFORE INSERT ON task_flow_history_events
        WHEN NEW.revision = 1
        BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;
      `);

      expect(
        updateFlowRecordByIdExpectedRevision({
          flowId: created.flowId,
          expectedRevision: 0,
          patch: { status: "running" },
        }),
      ).toMatchObject({ applied: false, reason: "persist_failed" });
      expect(getTaskFlowById(created.flowId)).toMatchObject({ revision: 0, status: "queued" });
      expect(
        listTaskFlowHistoryForOwnerFromSqlite({
          ownerKey: created.ownerKey,
          controllerId,
        }).events,
      ).toHaveLength(1);
    });
  });

  it("exposes cursor-paginated history only through the registered bound controller", async () => {
    await withFlowRegistryTempDir(async () => {
      const runtime = createRuntimeTaskFlow();
      const ownerHistory = runtime
        .bindSession({ sessionKey: "agent:owner:plugin-history" })
        .registerHistoryController({ controllerId: "tests/plugin-history" });
      const legacy = runtime
        .bindSession({ sessionKey: "agent:owner:plugin-history" })
        .createManaged({
          controllerId: "tests/plugin-history",
          goal: "Existing flow",
        });
      const enabledAt = Date.now();
      expect(ownerHistory.enable({ flowId: legacy.flowId, enabledAt })).toBe(true);
      const first = ownerHistory.createManaged({ goal: "First" });
      const second = ownerHistory.createManaged({ goal: "Second" });
      expect(first.controllerId).toBe(ownerHistory.controllerId);
      expect(second.controllerId).toBe(ownerHistory.controllerId);

      const firstPage = ownerHistory.list({ limit: 1 });
      expect(firstPage.events).toHaveLength(1);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const secondPage = ownerHistory.list({ cursor: firstPage.nextCursor, limit: 1 });
      expect(secondPage.events).toHaveLength(1);
      expect(secondPage.events[0]?.flowId).not.toBe(firstPage.events[0]?.flowId);
      expect(ownerHistory.list({ flowId: legacy.flowId }).events).toMatchObject([
        { eventType: "enabled", occurredAt: enabledAt },
      ]);
      expect(
        runtime
          .bindSession({ sessionKey: "agent:other:plugin-history" })
          .registerHistoryController({ controllerId: "tests/plugin-history" })
          .list(),
      ).toMatchObject({ events: [], archives: [] });
      expect(
        runtime
          .bindSession({ sessionKey: "agent:owner:plugin-history" })
          .registerHistoryController({ controllerId: "tests/other-controller" })
          .list(),
      ).toMatchObject({ events: [], archives: [] });
    });
  });
});
