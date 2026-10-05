import {
  applyFlowPatch,
  normalizeRestoredFlowRecord,
} from "../tasks/task-flow-registry.records.js";
import type { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import type {
  TaskFlowRegistryObservedUpdate,
  TaskFlowRegistryStoreSnapshot,
} from "../tasks/task-flow-registry.store.types.js";
type TaskFlowRegistryStore = ReturnType<typeof getTaskFlowRegistryStore>;
export function createInMemoryTaskFlowRegistryStore(
  snapshot: TaskFlowRegistryStoreSnapshot = { flows: new Map() },
): TaskFlowRegistryStore {
  const state = structuredClone(snapshot);
  return {
    withSnapshotAsync: async (_context, consume) => consume(structuredClone(state)),
    readFlowAsync: async (_context, flowId) => structuredClone(state.flows.get(flowId)),
    loadSnapshot: () => structuredClone(state),
    upsertFlow: (flow) => {
      state.flows.set(flow.flowId, structuredClone(flow));
    },
    updateFlow: (params, preparePublication) => {
      const publish = (result: TaskFlowRegistryObservedUpdate) => {
        const publication = preparePublication(result);
        publication.stage();
        publication.commit();
        publication.publish();
        return result;
      };
      const stored = state.flows.get(params.flowId);
      if (!stored) {
        return publish({ applied: false, reason: "not_found" });
      }
      const current = normalizeRestoredFlowRecord(stored);
      if (current.revision !== params.expectedRevision) {
        return publish({
          applied: false,
          reason: "revision_conflict",
          current: structuredClone(current),
        });
      }
      let flow;
      try {
        flow = applyFlowPatch(current, params.patch);
      } catch (error) {
        return { applied: false, reason: "invalid_patch", error };
      }
      state.flows.set(flow.flowId, structuredClone(flow));
      return publish({ applied: true, previous: structuredClone(current), flow });
    },
    deleteFlow: (flowId) => {
      state.flows.delete(flowId);
    },
  };
}
