// Task-flow transitions and receipts built on the registry's revision-checked writes.
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  isCurrentTaskFlowDatabase,
  runTaskFlowRegistryWorkerMutation,
  updateFlowRecordByIdExpectedRevision,
  type PreparedManagedTaskFlowMutation,
} from "./task-flow-registry.js";
import { buildManagedTaskFlowPatch } from "./task-flow-registry.records.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { upsertTaskFlowRegistryRecordWithHistoryInStateTransaction } from "./task-flow-registry.store.sqlite.js";
import type {
  JsonValue,
  TaskFlowStatus,
  TaskFlowUpdateResult,
} from "./task-flow-registry.types.js";

export async function reconcileTaskFlowWorkerReceipts(
  context: OpenClawStateWorkerContext,
  flowIds: readonly string[],
): Promise<void> {
  if (flowIds.length === 0) {
    return;
  }
  context.admission.assertCurrent();
  if (!isCurrentTaskFlowDatabase(context.admission)) {
    return;
  }
  const store = getTaskFlowRegistryStore();
  await ensureTaskFlowRegistryReadyAsync(context);
  for (const flowId of new Set(flowIds)) {
    context.admission.assertCurrent();
    if (!isCurrentTaskFlowDatabase(context.admission) || getTaskFlowRegistryStore() !== store) {
      return;
    }
    // The receipt is already committed; publication still rereads the canonical row.
    await runTaskFlowRegistryWorkerMutation(
      { flowId, admission: context.admission },
      () => Promise.resolve(),
      () => store.readFlowAsync(context, flowId),
    );
  }
}

/** Writes a prepared Flow in the caller's state transaction and checks its database CAS. */
export function commitPreparedManagedTaskFlowMutationInStateTransaction(
  db: EngineConnection,
  prepared: PreparedManagedTaskFlowMutation,
): void {
  const current = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
      .selectFrom("flow_runs")
      .select(["revision", "owner_key", "controller_id", "sync_mode"])
      .where("flow_id", "=", prepared.flow.flowId),
  );
  if (prepared.previous) {
    if (
      normalizeSqliteNumber(current?.revision ?? null) !== prepared.previous.revision ||
      current?.owner_key !== prepared.previous.ownerKey ||
      current?.controller_id !== prepared.previous.controllerId ||
      current?.sync_mode !== "managed"
    ) {
      throw new Error("Managed Flow database revision changed.");
    }
  } else if (current) {
    throw new Error("Managed Flow already exists.");
  }
  upsertTaskFlowRegistryRecordWithHistoryInStateTransaction(db, prepared.flow, prepared.history);
}

export function setFlowWaiting(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("setWaiting", params),
  });
}

export function resumeFlow(params: {
  flowId: string;
  expectedRevision: number;
  status?: Extract<TaskFlowStatus, "queued" | "running">;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("resume", params),
  });
}

export function finishFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("finish", params),
  });
}

export function failFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("fail", params),
  });
}

export function requestFlowCancel(params: {
  flowId: string;
  expectedRevision: number;
  cancelRequestedAt?: number;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("requestCancel", params),
  });
}
