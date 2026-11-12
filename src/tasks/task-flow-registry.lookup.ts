// Owner-key and token lookups over the task-flow registry projection.
import { getTaskFlowById, listTaskFlowsForOwnerKey } from "./task-flow-registry.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";

export function findLatestTaskFlowForOwnerKey(ownerKey: string): TaskFlowRecord | undefined {
  return listTaskFlowsForOwnerKey(ownerKey)[0];
}

// Owner-key actions must target live work before retained terminal history;
// otherwise `show` and `cancel` silently act on a completed flow.
export function findTaskFlowForOwnerLookup(ownerKey: string): TaskFlowRecord | undefined {
  const ownerFlows = listTaskFlowsForOwnerKey(ownerKey);
  return ownerFlows.find((flow) => !isTerminalTaskFlow(flow)) ?? ownerFlows[0];
}

export function resolveTaskFlowForLookupToken(token: string): TaskFlowRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return getTaskFlowById(lookup) ?? findTaskFlowForOwnerLookup(lookup);
}
