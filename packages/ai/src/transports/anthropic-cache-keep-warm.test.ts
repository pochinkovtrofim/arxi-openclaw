import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  holdAnthropicCacheKeepWarm,
  pauseAnthropicCacheKeepWarm,
  readAnthropicCacheKeepWarmTouch,
} from "./anthropic-cache-keep-warm.js";

const MINUTE = 60_000;
const keepWarm = { key: "chat", maxIdleMs: 120 * MINUTE };

describe("anthropic cache keep-warm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays after each quiet period until the session has been quiet too long", async () => {
    const replay = vi.fn(async () => true);
    holdAnthropicCacheKeepWarm(keepWarm, "claude", Date.now(), replay);
    await vi.advanceTimersByTimeAsync(55 * MINUTE - 1);
    expect(replay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(readAnthropicCacheKeepWarmTouch("chat", "claude")).toBe(55 * MINUTE);
    expect(readAnthropicCacheKeepWarmTouch("chat", "other-model")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it("restarts the wait on every request and drops a refresh that raced one", async () => {
    const pending = createDeferred<boolean>();
    const replay = vi.fn(() => pending.promise);
    holdAnthropicCacheKeepWarm(keepWarm, "claude", Date.now(), replay);
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    pauseAnthropicCacheKeepWarm("chat");
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(readAnthropicCacheKeepWarmTouch("chat", "claude")).toBe(0);

    const next = vi.fn(async () => true);
    holdAnthropicCacheKeepWarm(keepWarm, "claude", Date.now(), next);
    await vi.advanceTimersByTimeAsync(55 * MINUTE - 1);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "after a failed replay", refreshed: false, sleptMs: 0 },
    {
      name: "when the Gateway slept past the cache TTL",
      refreshed: true,
      sleptMs: 2 * 60 * MINUTE,
    },
  ])("stops $name", async ({ refreshed, sleptMs }) => {
    const replay = vi.fn(async () => refreshed);
    holdAnthropicCacheKeepWarm(keepWarm, "claude", Date.now(), replay);
    vi.setSystemTime(sleptMs);
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
    expect(replay).toHaveBeenCalledTimes(sleptMs ? 0 : 1);
    expect(readAnthropicCacheKeepWarmTouch("chat", "claude")).toBe(0);
  });
});
