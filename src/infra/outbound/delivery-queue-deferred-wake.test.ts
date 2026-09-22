import { afterEach, describe, expect, it, vi } from "vitest";
import { getNextDeferredOutboundDeliveryAtMs } from "./delivery-queue-deferred-wake.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

describe("outbound deferred-delivery wake snapshot", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects only the earliest semantic deferral and clamps a due row to now", async () => {
    vi.useFakeTimers();
    const now = 1_800_000_000_000;
    vi.setSystemTime(now);
    const stateDir = tmpDir();
    const ordinaryLease = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "lease" }] },
      stateDir,
    );
    const deferred = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "deferred" }] },
      stateDir,
    );
    const mismatchedMarker = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "mismatch" }] },
      stateDir,
    );
    setQueuedEntryState(stateDir, ordinaryLease, { retryCount: 0, availableAt: now + 1_000 });
    setQueuedEntryState(stateDir, deferred, {
      retryCount: 0,
      availableAt: now + 60_000,
      deferredUntilMs: now + 60_000,
    });
    setQueuedEntryState(stateDir, mismatchedMarker, {
      retryCount: 0,
      availableAt: now + 30_000,
      deferredUntilMs: now + 90_000,
    });

    expect(getNextDeferredOutboundDeliveryAtMs(stateDir)).toBe(now + 60_000);
    expect(getNextDeferredOutboundDeliveryAtMs(stateDir, undefined, now + 60_001)).toBe(
      now + 60_001,
    );
  });
});
