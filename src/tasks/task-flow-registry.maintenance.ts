import {
  deleteTaskFlowRecordById,
  listTaskFlowRecords,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { isTerminalTaskFlow } from "./task-flow-registry.types.js";

const TASK_FLOW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Retained managed controllers share the Gateway's existing maintenance lifetime. */
export function runTaskFlowRegistryMaintenance(now = Date.now()): void {
  // This read fails closed when restoration is unavailable; no partial projection is pruned.
  const flows = listTaskFlowRecords();
  getTaskFlowRegistryStore().pruneHistory?.(now);
  for (const flow of flows) {
    // Historical task-mirrored records have no executor in this release.
    if (flow.syncMode !== "managed") {
      continue;
    }
    if (!isTerminalTaskFlow(flow) && flow.cancelRequestedAt != null) {
      const endedAt = Math.max(now, flow.updatedAt, flow.cancelRequestedAt);
      updateFlowRecordByIdExpectedRevision({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        patch: {
          status: "cancelled",
          waitJson: null,
          blockedTaskId: null,
          blockedSummary: null,
          endedAt,
          updatedAt: endedAt,
        },
      });
    } else if (
      isTerminalTaskFlow(flow) &&
      now - (flow.endedAt ?? flow.updatedAt ?? flow.createdAt) >= TASK_FLOW_RETENTION_MS
    ) {
      deleteTaskFlowRecordById(flow.flowId);
    }
  }
}
