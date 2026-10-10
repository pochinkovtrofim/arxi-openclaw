import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { resolveLocalEmbeddingSchedule } from "./embedding-scheduler.js";

type SentRequest = { slice: string[]; release: () => void; released: boolean };

const textOf = (input: EmbeddingInput) => (typeof input === "string" ? input : input.text);

function createSendRecorder() {
  const sent: SentRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const send = async (inputs: EmbeddingInput[]) => {
    const slice = inputs.map(textOf);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const completion = createDeferred<void>();
    sent.push({ slice, release: completion.resolve, released: false });
    await completion.promise;
    active -= 1;
    return slice.map((input) => [input.length]);
  };
  const releaseNext = () => {
    const pending = sent.find((request) => !request.released);
    if (!pending) {
      return false;
    }
    pending.released = true;
    pending.release();
    return true;
  };
  return {
    sent,
    send,
    releaseNext,
    get maxActive() {
      return maxActive;
    },
  };
}

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("local embedding schedule", () => {
  it("sends index inputs in short sub-requests, one at a time per server, in input order", async () => {
    const schedule = resolveLocalEmbeddingSchedule("http://127.0.0.1:19450/v1");
    const recorder = createSendRecorder();
    const batch = schedule.runIndexBatch(
      ["a", "bb", "ccc", "dddd", "eeeee"],
      undefined,
      recorder.send,
    );
    const other = schedule.runIndexBatch(["zz"], undefined, recorder.send);
    await flush();
    expect(recorder.sent.map((request) => request.slice)).toEqual([["a", "bb"]]);

    while (recorder.releaseNext()) {
      await flush();
    }

    expect(await batch).toEqual([[1], [2], [3], [4], [5]]);
    expect(await other).toEqual([[2]]);
    expect(recorder.sent.map((request) => request.slice)).toEqual([
      ["a", "bb"],
      ["ccc", "dddd"],
      ["eeeee"],
      ["zz"],
    ]);
    expect(recorder.maxActive).toBe(1);
  });

  it("serves a waiting query before the next index sub-request", async () => {
    const schedule = resolveLocalEmbeddingSchedule("http://127.0.0.1:19451/v1");
    const recorder = createSendRecorder();
    const order: string[] = [];
    const batch = schedule.runIndexBatch(["a", "b", "c", "d"], undefined, async (slice) => {
      order.push(`batch:${slice.map(textOf).join("")}`);
      return await recorder.send(slice);
    });
    await flush();
    expect(order).toEqual(["batch:ab"]);

    const queryStarted = createDeferred<void>();
    const query = schedule.runQuery(async () => {
      order.push("query");
      await queryStarted.promise;
      return [1];
    });
    await flush();
    // The query starts immediately; it never waits for the in-flight sub-request.
    expect(order).toEqual(["batch:ab", "query"]);

    recorder.releaseNext();
    await flush();
    // The next sub-request waits while the query is still pending.
    expect(order).toEqual(["batch:ab", "query"]);

    queryStarted.resolve();
    expect(await query).toEqual([1]);
    await flush();
    expect(order).toEqual(["batch:ab", "query", "batch:cd"]);
    recorder.releaseNext();
    expect(await batch).toEqual([[1], [1], [1], [1]]);
  });

  it("releases an aborted waiter's turn to the batches queued behind it", async () => {
    const schedule = resolveLocalEmbeddingSchedule("http://127.0.0.1:19452/v1");
    const recorder = createSendRecorder();
    const first = schedule.runIndexBatch(["a"], undefined, recorder.send);
    const controller = new AbortController();
    const aborted = schedule.runIndexBatch(["b"], controller.signal, recorder.send);
    const third = schedule.runIndexBatch(["c"], undefined, recorder.send);
    await flush();
    controller.abort(new Error("index cancelled"));
    await expect(aborted).rejects.toThrow("index cancelled");

    recorder.releaseNext();
    await flush();
    expect(recorder.sent.map((request) => request.slice)).toEqual([["a"], ["c"]]);
    recorder.releaseNext();
    expect(await first).toEqual([[1]]);
    expect(await third).toEqual([[1]]);
  });

  it("keys the schedule by server so different servers never wait on each other", async () => {
    const left = resolveLocalEmbeddingSchedule("http://127.0.0.1:19453/v1");
    const right = resolveLocalEmbeddingSchedule("http://127.0.0.1:19454/v1/");
    expect(resolveLocalEmbeddingSchedule("http://127.0.0.1:19453/v1/")).toBe(left);
    const recorder = createSendRecorder();
    const leftBatch = left.runIndexBatch(["a"], undefined, recorder.send);
    const rightBatch = right.runIndexBatch(["b"], undefined, recorder.send);
    await flush();
    expect(recorder.sent.map((request) => request.slice)).toEqual([["a"], ["b"]]);
    while (recorder.releaseNext()) {
      await flush();
    }
    await Promise.all([leftBatch, rightBatch]);
  });
});
