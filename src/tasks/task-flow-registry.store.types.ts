// Defines storage contracts for managed task-flow records.
import type { FlowRecordPatch } from "./task-flow-registry.records.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

/** Explicit opt-in for a controller's durable transition timeline. */
export type TaskFlowHistoryRegistration = {
  controllerId: string;
  /** Present only when an already-running Flow begins retaining future history. */
  enabledAt?: number;
};

export type TaskFlowHistoryEvent = {
  flowId: string;
  revision: number;
  occurredAt: number;
  eventType: "created" | "enabled" | "transition";
  digest: string;
  snapshot: {
    status: TaskFlowRecord["status"];
    goal: string;
    currentStep?: string;
    blockedSummary?: string;
    stateJson?: TaskFlowRecord["stateJson"];
    waitJson?: TaskFlowRecord["waitJson"];
    endedAt?: number;
  };
};

export type TaskFlowHistoryArchive = {
  flowId: string;
  firstRevision: number;
  lastRevision: number;
  firstOccurredAt: number;
  lastOccurredAt: number;
  eventCount: number;
  digest: string;
};

export type TaskFlowHistoryPage = {
  /** The native detail retention contract, independent of Task Flow GC. */
  retentionDays: number;
  /** Detail before this instant may be represented only by an archive receipt. */
  availableSince: number;
  events: TaskFlowHistoryEvent[];
  archives: TaskFlowHistoryArchive[];
  nextCursor?: string;
};

/** Full task-flow registry snapshot used for persistence restore and replacement writes. */
export type TaskFlowRegistryUpdate = {
  flowId: string;
  expectedRevision: number;
  patch: FlowRecordPatch;
};

export type TaskFlowRegistryObservedUpdate =
  | { applied: true; previous: TaskFlowRecord; flow: TaskFlowRecord }
  | { applied: false; reason: "not_found" }
  | { applied: false; reason: "revision_conflict"; current: TaskFlowRecord };

export type TaskFlowRegistryUpdateResult =
  | TaskFlowRegistryObservedUpdate
  | { applied: false; reason: "invalid_patch"; error: unknown };

/** Stage read-your-writes state separately from committed observer publication. */
export type TaskFlowRegistryUpdatePublication = {
  stage: () => void;
  rollback: () => void;
  commit: () => void;
  publish: () => void;
};

/** Full task-flow registry snapshot used for persistence restore and replacement writes. */
export type TaskFlowRegistryStoreSnapshot = {
  flows: Map<string, TaskFlowRecord>;
};
