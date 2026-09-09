// Defines storage contracts for managed task-flow records.
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
export type TaskFlowRegistryStoreSnapshot = {
  flows: Map<string, TaskFlowRecord>;
};
