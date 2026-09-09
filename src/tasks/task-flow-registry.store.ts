// Stores managed task-flow records in memory and notifies registry observers.
import {
  closeTaskFlowRegistryDatabase,
  deleteTaskFlowRegistryRecordFromSqlite,
  listTaskFlowHistoryForOwnerFromSqlite,
  loadTaskFlowRegistryStateFromSqlite,
  pruneTaskFlowHistoryFromSqlite,
  saveTaskFlowRegistryStateToSqlite,
  upsertTaskFlowRegistryRecordWithHistoryToSqlite,
  upsertTaskFlowRegistryRecordToSqlite,
  upsertTerminalManagedTaskFlowRecordWithObligationCleanupToSqlite,
} from "./task-flow-registry.store.sqlite.js";
import type {
  TaskFlowHistoryPage,
  TaskFlowHistoryRegistration,
  TaskFlowRegistryStoreSnapshot,
} from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

type TaskFlowRegistryStore = {
  loadSnapshot: () => TaskFlowRegistryStoreSnapshot;
  saveSnapshot: (snapshot: TaskFlowRegistryStoreSnapshot) => void;
  upsertFlow?: (flow: TaskFlowRecord) => void;
  upsertFlowWithHistory?: (flow: TaskFlowRecord, history?: TaskFlowHistoryRegistration) => void;
  upsertTerminalManagedFlowWithObligationCleanup?: (
    flow: TaskFlowRecord,
    history?: TaskFlowHistoryRegistration,
  ) => void;
  deleteFlow?: (flowId: string) => void;
  listHistory?: (params: {
    flowId?: string;
    ownerKey: string;
    controllerId: string;
    cursor?: string;
    limit?: number;
  }) => TaskFlowHistoryPage;
  pruneHistory?: (now?: number) => number;
  close?: () => void;
};

export type TaskFlowRegistryObserverEvent =
  | {
      kind: "restored";
      flows: TaskFlowRecord[];
    }
  | {
      kind: "upserted";
      flow: TaskFlowRecord;
      previous?: TaskFlowRecord;
    }
  | {
      kind: "deleted";
      flowId: string;
      previous: TaskFlowRecord;
    };

type TaskFlowRegistryObservers = {
  // Observers are incremental/best-effort only. Snapshot persistence belongs to TaskFlowRegistryStore.
  onEvent?: (event: TaskFlowRegistryObserverEvent) => void;
};

const defaultFlowRegistryStore: TaskFlowRegistryStore = {
  loadSnapshot: loadTaskFlowRegistryStateFromSqlite,
  saveSnapshot: saveTaskFlowRegistryStateToSqlite,
  upsertFlow: upsertTaskFlowRegistryRecordToSqlite,
  upsertFlowWithHistory: upsertTaskFlowRegistryRecordWithHistoryToSqlite,
  upsertTerminalManagedFlowWithObligationCleanup:
    upsertTerminalManagedTaskFlowRecordWithObligationCleanupToSqlite,
  deleteFlow: deleteTaskFlowRegistryRecordFromSqlite,
  listHistory: listTaskFlowHistoryForOwnerFromSqlite,
  pruneHistory: pruneTaskFlowHistoryFromSqlite,
  close: closeTaskFlowRegistryDatabase,
};

let configuredFlowRegistryStore: TaskFlowRegistryStore = defaultFlowRegistryStore;
let configuredFlowRegistryObservers: TaskFlowRegistryObservers | null = null;

export function getTaskFlowRegistryStore(): TaskFlowRegistryStore {
  return configuredFlowRegistryStore;
}

export function getTaskFlowRegistryObservers(): TaskFlowRegistryObservers | null {
  return configuredFlowRegistryObservers;
}

function configureTaskFlowRegistryRuntime(params: {
  store?: TaskFlowRegistryStore;
  observers?: TaskFlowRegistryObservers | null;
}) {
  if (params.store) {
    configuredFlowRegistryStore = params.store;
  }
  if ("observers" in params) {
    configuredFlowRegistryObservers = params.observers ?? null;
  }
}

export function resetTaskFlowRegistryRuntimeForTests() {
  configuredFlowRegistryStore.close?.();
  configuredFlowRegistryStore = defaultFlowRegistryStore;
  configuredFlowRegistryObservers = null;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.taskFlowRegistryStoreTestApi")
  ] = { configureTaskFlowRegistryRuntime };
}
