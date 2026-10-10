import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWorkerComputeCapacity,
  type WorkerComputeClass,
  type WorkerComputePermit,
} from "./worker-task-capacity.js";

const host = vi.hoisted(() => ({ parallelism: 2 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => host.parallelism,
}));

const CAPACITY_KEY = Symbol.for("openclaw.workerComputeCapacity");
type Capacity = ReturnType<typeof getWorkerComputeCapacity>;

/** A fresh process-wide capacity sized for a host with `parallelism` cores. */
function createWorkerComputeCapacity(parallelism: number): Capacity {
  host.parallelism = parallelism;
  Reflect.deleteProperty(globalThis, CAPACITY_KEY);
  return getWorkerComputeCapacity();
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, CAPACITY_KEY);
});

/** A pool stand-in: one queued task per pool, resumed by the capacity like the pool core. */
function createContender(
  capacity: Capacity,
  name: string,
  computeClass: WorkerComputeClass,
  order: string[],
  checkpoint = () => false,
) {
  const contender = {
    permit: undefined as WorkerComputePermit | undefined,
    acquire() {
      contender.permit = capacity.acquire(contender.resume, checkpoint, computeClass);
      if (contender.permit) {
        order.push(name);
      }
      return contender.permit;
    },
    resume: () => {
      contender.acquire();
    },
    release() {
      const permit = contender.permit!;
      contender.permit = undefined;
      capacity.release(permit);
    },
  };
  return contender;
}

describe("worker compute capacity", () => {
  it("keeps an interactive permit free of batch work on a two-core host", () => {
    const capacity = createWorkerComputeCapacity(2);
    const order: string[] = [];
    const index = createContender(capacity, "index", "batch", order);
    const transcript = createContender(capacity, "transcript", "batch", order);
    const write = createContender(capacity, "write", "interactive", order);
    const search = createContender(capacity, "search", "interactive", order);

    expect(index.acquire()).toBeDefined();
    expect(transcript.acquire()).toBeUndefined();
    expect(write.acquire()).toBeDefined();
    expect(search.acquire()).toBeUndefined();
    expect(capacity.getSnapshot()).toMatchObject({
      limit: 1,
      interactiveLimit: 2,
      active: 2,
      activeInteractive: 1,
      waitingPools: 2,
      waitingInteractivePools: 1,
    });

    // The batch release goes to the interactive waiter that queued after the batch waiter.
    index.release();
    expect(order).toEqual(["index", "write", "search"]);
    expect(transcript.permit).toBeUndefined();

    // Batch work resumes only below the batch limit, never in the reserved permit.
    write.release();
    expect(transcript.permit).toBeUndefined();
    search.release();
    expect(order).toEqual(["index", "write", "search", "transcript"]);
    expect(capacity.getSnapshot()).toMatchObject({ active: 1, waitingPools: 0 });
  });

  it("does not let a batch loop re-acquire ahead of a waiting interactive task", () => {
    const capacity = createWorkerComputeCapacity(2);
    const order: string[] = [];
    const batch = createContender(capacity, "batch", "batch", order);
    const holder = createContender(capacity, "holder", "interactive", order);
    const waiter = createContender(capacity, "waiter", "interactive", order);
    batch.acquire();
    holder.acquire();
    expect(waiter.acquire()).toBeUndefined();

    // A chunked batch releases between chunks and immediately submits its next chunk.
    batch.release();
    expect(batch.acquire()).toBeUndefined();
    expect(order).toEqual(["batch", "holder", "waiter"]);

    holder.release();
    expect(batch.permit).toBeUndefined();
    waiter.release();
    expect(order).toEqual(["batch", "holder", "waiter", "batch"]);
  });

  it("asks batch holders to checkpoint before interactive holders", () => {
    const capacity = createWorkerComputeCapacity(2);
    const order: string[] = [];
    const requested: string[] = [];
    const checkpoint = (name: string) => () => {
      requested.push(name);
      return true;
    };
    createContender(capacity, "index", "batch", order, checkpoint("index")).acquire();
    createContender(capacity, "chat", "interactive", order, checkpoint("chat")).acquire();
    expect(order).toEqual(["index", "chat"]);

    expect(createContender(capacity, "write", "interactive", order).acquire()).toBeUndefined();
    expect(requested).toEqual(["index"]);
  });

  it("keeps the limit on larger hosts and only lets interactive work resume first", () => {
    const capacity = createWorkerComputeCapacity(4);
    const order: string[] = [];
    const batches = Array.from({ length: 4 }, (_, index) =>
      createContender(capacity, `batch-${index}`, "batch", order),
    );
    const interactive = createContender(capacity, "interactive", "interactive", order);
    expect(batches.map((entry) => Boolean(entry.acquire()))).toEqual([true, true, true, false]);
    expect(interactive.acquire()).toBeUndefined();
    expect(capacity.getSnapshot()).toMatchObject({ limit: 3, interactiveLimit: 3, active: 3 });

    // The interactive pool queued after batch-3 still takes the next released permit.
    batches[0]!.release();
    expect(order.at(-1)).toBe("interactive");
    expect(batches[3]!.permit).toBeUndefined();
    expect(capacity.getSnapshot()).toMatchObject({ active: 3, waitingPools: 1 });
  });

  it("drops a removed waiter without resuming it", () => {
    const capacity = createWorkerComputeCapacity(1);
    const order: string[] = [];
    const holder = createContender(capacity, "holder", "batch", order);
    const reserve = createContender(capacity, "reserve", "interactive", order);
    const closed = createContender(capacity, "closed", "interactive", order);
    holder.acquire();
    reserve.acquire();
    closed.acquire();
    capacity.remove(closed.resume);
    reserve.release();
    expect(order).toEqual(["holder", "reserve"]);
    expect(capacity.getSnapshot()).toMatchObject({ active: 1, waitingPools: 0 });
  });
});
