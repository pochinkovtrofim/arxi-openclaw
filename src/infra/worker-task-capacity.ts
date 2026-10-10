import { availableParallelism } from "node:os";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const DEFAULT_WORKER_PENDING_TASKS = 128;
export const DEFAULT_WORKER_PENDING_BYTES = 256 * 1024 * 1024;
/** Hosts at or below this parallelism keep one permit that only interactive pools may occupy. */
const INTERACTIVE_WORKER_COMPUTE_RESERVE_MAX_PARALLELISM = 2;

/**
 * Interactive pools serve a caller that is waiting on the result (tool planning, retrieval,
 * trigger evaluation). Batch pools (indexing, transcript scans, extraction) never delay them.
 */
export type WorkerComputeClass = "interactive" | "batch";
export type WorkerComputePermit = {
  requestCheckpoint: () => boolean;
  computeClass: WorkerComputeClass;
};

/** Shared compute admission; database and generation workers keep their own ordering. */
export function getWorkerComputeCapacity() {
  return resolveGlobalSingleton(Symbol.for("openclaw.workerComputeCapacity"), () =>
    createWorkerComputeCapacity(availableParallelism()),
  );
}

function createWorkerComputeCapacity(parallelism: number) {
  // Batch work leaves one core to the event loop. On small hosts that leaves a single permit,
  // so interactive work gets one reserved permit on top (2 workers on 2 cores); larger hosts
  // keep their limit and only reorder admission.
  const limit = Math.max(1, parallelism - 1);
  const interactiveLimit =
    limit + Number(parallelism <= INTERACTIVE_WORKER_COMPUTE_RESERVE_MAX_PARALLELISM);
  const limitFor = (computeClass: WorkerComputeClass) =>
    computeClass === "interactive" ? interactiveLimit : limit;
  const active = new Set<WorkerComputePermit>();
  const waiting: Record<WorkerComputeClass, Set<() => void>> = {
    interactive: new Set(),
    batch: new Set(),
  };
  let pendingTasks = 0;
  let pendingBytes = 0;
  let draining = false;
  const requestCheckpoints = () => {
    let demand = waiting.interactive.size + waiting.batch.size;
    if (!demand) {
      return;
    }
    // Batch holders yield first; interactive holders cover only the remaining demand.
    for (const computeClass of ["batch", "interactive"] as const) {
      for (const permit of active) {
        if (
          permit.computeClass === computeClass &&
          permit.requestCheckpoint() &&
          --demand === 0
        ) {
          return;
        }
      }
    }
  };
  const drain = () => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      // Interactive waiters resume first at every release; batch waiters fill what remains.
      for (const computeClass of ["interactive", "batch"] as const) {
        const queue = waiting[computeClass];
        while (active.size < limitFor(computeClass) && queue.size) {
          const next = queue.values().next().value!;
          queue.delete(next);
          next();
        }
      }
    } finally {
      draining = false;
    }
    requestCheckpoints();
  };
  return {
    getSnapshot: () => {
      let activeInteractive = 0;
      for (const permit of active) {
        activeInteractive += Number(permit.computeClass === "interactive");
      }
      return {
        limit,
        interactiveLimit,
        active: active.size,
        activeInteractive,
        waitingPools: waiting.interactive.size + waiting.batch.size,
        waitingInteractivePools: waiting.interactive.size,
        pendingTasks,
        pendingBytes,
      };
    },
    admit(bytes: number): boolean {
      if (
        pendingTasks >= DEFAULT_WORKER_PENDING_TASKS ||
        pendingBytes + bytes > DEFAULT_WORKER_PENDING_BYTES
      ) {
        return false;
      }
      pendingTasks++;
      pendingBytes += bytes;
      return true;
    },
    finish(bytes: number) {
      pendingTasks--;
      pendingBytes -= bytes;
    },
    acquire(
      resume: () => void,
      requestCheckpoint: () => boolean,
      computeClass: WorkerComputeClass = "batch",
    ): WorkerComputePermit | undefined {
      // A newly submitting pool must not overtake an already waiting pool of its class,
      // and batch work never overtakes a waiting interactive pool.
      if (
        active.size >= limitFor(computeClass) ||
        (!draining &&
          (waiting.interactive.size > 0 || (computeClass === "batch" && waiting.batch.size > 0)))
      ) {
        waiting[computeClass].add(resume);
        requestCheckpoints();
        return undefined;
      }
      const permit = { requestCheckpoint, computeClass };
      active.add(permit);
      return permit;
    },
    release(permit: WorkerComputePermit) {
      active.delete(permit);
      drain();
    },
    remove(resume: () => void) {
      waiting.interactive.delete(resume);
      waiting.batch.delete(resume);
    },
    requestCheckpoints,
  };
}
