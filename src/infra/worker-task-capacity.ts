import { availableParallelism } from "node:os";
import { createWorkerComputeCapacity } from "@openclaw/worker-runtime";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { emitInternalDiagnosticEvent } from "./diagnostic-events.js";

export {
  DEFAULT_WORKER_PENDING_TASKS,
  DEFAULT_WORKER_PENDING_BYTES,
  workerComputeLane,
  type WorkerComputeClass,
  type WorkerComputeLane,
  type WorkerComputePermit,
} from "@openclaw/worker-runtime";

/** Hosts at or below this parallelism keep one permit that only interactive pools may occupy. */
const INTERACTIVE_WORKER_COMPUTE_RESERVE_MAX_PARALLELISM = 2;

/** All runtime chunks share the same host-owned computation budget. */
export function getWorkerComputeCapacity() {
  return resolveGlobalSingleton(Symbol.for("openclaw.workerComputeCapacity"), () =>
    createHostWorkerComputeCapacity(availableParallelism()),
  );
}

/**
 * Batch work leaves one core to the event loop. On small hosts that leaves a single permit,
 * so interactive work gets one reserved permit on top (2 workers on 2 cores); larger hosts
 * keep their limit and only reorder admission.
 */
export function createHostWorkerComputeCapacity(parallelism: number) {
  const limit = Math.max(1, parallelism - 1);
  return createWorkerComputeCapacity(limit, {
    interactiveLimit:
      limit + Number(parallelism <= INTERACTIVE_WORKER_COMPUTE_RESERVE_MAX_PARALLELISM),
    onDequeue: (event) => emitInternalDiagnosticEvent({ type: "queue.lane.dequeue", ...event }),
  });
}
