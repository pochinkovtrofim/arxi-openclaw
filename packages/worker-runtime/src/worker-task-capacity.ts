export const DEFAULT_WORKER_PENDING_TASKS = 128;
export const DEFAULT_WORKER_PENDING_BYTES = 256 * 1024 * 1024;
/**
 * Interactive pools serve a caller that is waiting on the result (tool planning, retrieval,
 * trigger evaluation). Batch pools (indexing, transcript scans, extraction) never delay them.
 */
export type WorkerComputeClass = "interactive" | "batch";
export type WorkerComputePermit = {
  requestCheckpoint: () => boolean;
  computeClass: WorkerComputeClass;
};

/** A pool's admission class and its content-free diagnostic lane (class and worker entry). */
export type WorkerComputeLane = { computeClass: WorkerComputeClass; lane: string };

export function workerComputeLane(
  workerUrl: URL,
  sharedCompute: boolean | "interactive" | undefined,
): WorkerComputeLane {
  const computeClass = sharedCompute === "interactive" ? "interactive" : "batch";
  const entry = (workerUrl.pathname.split("/").at(-1) ?? "")
    .replace(/\.[cm]?[jt]s$/u, "")
    .replace(/[^A-Za-z0-9_.-]/gu, "_")
    .slice(0, 80);
  return { computeClass, lane: `compute.${computeClass}.${entry || "unknown"}` };
}

const BATCH_LANE: WorkerComputeLane = { computeClass: "batch", lane: "compute.batch.unknown" };

/** Content-free admission fact for a granted shared-compute permit. */
export type WorkerComputeDequeue = { lane: string; queueSize: number; waitMs: number };

/**
 * Shared compute admission; database and generation workers keep their own ordering.
 * `interactiveLimit` may exceed `limit` by a permit only interactive pools occupy.
 */
export function createWorkerComputeCapacity(
  limit: number,
  options: { interactiveLimit?: number; onDequeue?: (event: WorkerComputeDequeue) => void } = {},
) {
  const interactiveLimit = options.interactiveLimit ?? limit;
  for (const value of [limit, interactiveLimit]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError("compute capacity must be a positive safe integer");
    }
  }
  if (interactiveLimit < limit) {
    throw new RangeError("interactive compute capacity must not be below the batch limit");
  }
  const limitFor = (computeClass: WorkerComputeClass) =>
    computeClass === "interactive" ? interactiveLimit : limit;
  const active = new Set<WorkerComputePermit>();
  const waiting: Record<WorkerComputeClass, Set<() => void>> = {
    interactive: new Set(),
    batch: new Set(),
  };
  // Separate admission budgets: a batch backlog must not reject an interactive request.
  const pending: Record<WorkerComputeClass, { tasks: number; bytes: number }> = {
    interactive: { tasks: 0, bytes: 0 },
    batch: { tasks: 0, bytes: 0 },
  };
  // First refused admission per waiting pool; a grant reports the wait as a lane diagnostic.
  const waitSince = new Map<() => void, number>();
  let draining = false;
  const requestCheckpoints = () => {
    let demand = waiting.interactive.size + waiting.batch.size;
    if (!demand) {
      return;
    }
    // Batch holders yield first; interactive holders cover only the remaining demand.
    for (const computeClass of ["batch", "interactive"] as const) {
      for (const permit of active) {
        if (permit.computeClass === computeClass && permit.requestCheckpoint() && --demand === 0) {
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
          // A resumed pool that could not start (no free worker) restarts its wait later.
          waitSince.delete(next);
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
        pendingTasks: pending.interactive.tasks + pending.batch.tasks,
        pendingBytes: pending.interactive.bytes + pending.batch.bytes,
      };
    },
    admit(bytes: number, computeClass: WorkerComputeClass = "batch"): boolean {
      const budget = pending[computeClass];
      if (
        budget.tasks >= DEFAULT_WORKER_PENDING_TASKS ||
        budget.bytes + bytes > DEFAULT_WORKER_PENDING_BYTES
      ) {
        return false;
      }
      budget.tasks++;
      budget.bytes += bytes;
      return true;
    },
    finish(bytes: number, computeClass: WorkerComputeClass = "batch") {
      pending[computeClass].tasks--;
      pending[computeClass].bytes -= bytes;
    },
    acquire(
      resume: () => void,
      requestCheckpoint: () => boolean,
      compute: WorkerComputeLane = BATCH_LANE,
    ): WorkerComputePermit | undefined {
      const { computeClass } = compute;
      // A newly submitting pool must not overtake an already waiting pool of its class,
      // and batch work never overtakes a waiting interactive pool.
      if (
        active.size >= limitFor(computeClass) ||
        (!draining &&
          (waiting.interactive.size > 0 || (computeClass === "batch" && waiting.batch.size > 0)))
      ) {
        waiting[computeClass].add(resume);
        if (!waitSince.has(resume)) {
          waitSince.set(resume, performance.now());
        }
        requestCheckpoints();
        return undefined;
      }
      const permit = { requestCheckpoint, computeClass };
      active.add(permit);
      const startedAt = waitSince.get(resume);
      waitSince.delete(resume);
      options.onDequeue?.({
        lane: compute.lane,
        queueSize: waiting.interactive.size + waiting.batch.size,
        waitMs: startedAt === undefined ? 0 : Math.round(performance.now() - startedAt),
      });
      return permit;
    },
    release(permit: WorkerComputePermit) {
      active.delete(permit);
      drain();
    },
    remove(resume: () => void) {
      waitSince.delete(resume);
      waiting.interactive.delete(resume);
      waiting.batch.delete(resume);
    },
    requestCheckpoints,
  };
}

export type WorkerComputeCapacity = ReturnType<typeof createWorkerComputeCapacity>;
