import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";

// One managed llama-server serves interactive query embeddings and background
// index batches from the same CPU threads, and it runs its task queue in
// arrival order. A query posted behind several multi-input index requests
// therefore waits for every chunk ahead of it. Keeping the server queue shallow
// is the lossless fix: index requests go out one at a time per server, in short
// sub-requests, and only while no query is waiting. Every manager in the
// process (search, maintenance, session sync) shares the server, so the
// schedule is keyed by the server base URL rather than by provider instance.

/** Inputs per index sub-request; a waiting query is delayed by at most this many chunks. */
export const LOCAL_INDEX_REQUEST_INPUTS = 2;

type QueryDrain = { promise: Promise<void>; resolve: () => void };

class LocalEmbeddingSchedule {
  private pendingQueries = 0;
  private queryDrain: QueryDrain | undefined;
  private batchTail: Promise<void> = Promise.resolve();

  async runQuery<T>(run: () => Promise<T>): Promise<T> {
    this.pendingQueries += 1;
    try {
      return await run();
    } finally {
      this.pendingQueries -= 1;
      if (this.pendingQueries === 0 && this.queryDrain) {
        const drain = this.queryDrain;
        this.queryDrain = undefined;
        drain.resolve();
      }
    }
  }

  async runIndexBatch(
    inputs: EmbeddingInput[],
    signal: AbortSignal | undefined,
    send: (slice: EmbeddingInput[]) => Promise<number[][]>,
  ): Promise<number[][]> {
    const releaseTurn = await this.acquireBatchTurn(signal);
    try {
      const vectors: number[][] = [];
      for (let start = 0; start < inputs.length; start += LOCAL_INDEX_REQUEST_INPUTS) {
        await this.waitForQueriesToDrain(signal);
        vectors.push(...(await send(inputs.slice(start, start + LOCAL_INDEX_REQUEST_INPUTS))));
      }
      return vectors;
    } finally {
      releaseTurn();
    }
  }

  private async acquireBatchTurn(signal: AbortSignal | undefined): Promise<() => void> {
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const previous = this.batchTail;
    this.batchTail = previous.then(() => turn);
    try {
      await raceWithAbort(previous, signal);
    } catch (error) {
      // An aborted waiter must not hold the turn for everyone queued behind it.
      releaseTurn();
      throw error;
    }
    return releaseTurn;
  }

  private async waitForQueriesToDrain(signal: AbortSignal | undefined): Promise<void> {
    while (this.pendingQueries > 0) {
      this.queryDrain ??= createQueryDrain();
      await raceWithAbort(this.queryDrain.promise, signal);
    }
    signal?.throwIfAborted();
  }
}

function createQueryDrain(): QueryDrain {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function raceWithAbort(waited: Promise<void>, signal: AbortSignal | undefined) {
  if (!signal) {
    await waited;
    return;
  }
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([waited, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const schedulesByServer = new Map<string, LocalEmbeddingSchedule>();

/** The process-wide schedule for the managed llama-server at `baseUrl`. */
export function resolveLocalEmbeddingSchedule(baseUrl: string): LocalEmbeddingSchedule {
  const key = baseUrl.replace(/\/+$/u, "");
  let schedule = schedulesByServer.get(key);
  if (!schedule) {
    schedule = new LocalEmbeddingSchedule();
    schedulesByServer.set(key, schedule);
  }
  return schedule;
}

export type { LocalEmbeddingSchedule };
