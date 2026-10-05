import { afterEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { upsertDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { getNextDeferredOutboundDeliveryAtMs } from "./delivery-queue-deferred-wake.js";
import {
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
  COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-namespaces.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import {
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

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
  it.each(OUTBOUND_EXECUTABLE_QUEUE_NAMES)("retains wake deadlines in %s", (queueName) => {
    const stateDir = tmpDir();
    const now = 1_800_000_000_000;
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const entry: QueuedDelivery = {
      id: "deferred",
      enqueuedAt: now,
      retryCount: 0,
      attemptCount: 0,
      channel: "demo-channel-a",
      to: "+1",
      preparedBatch: createUnmodifiedPreparedOutboundBatch([{ text: "later" }]),
      availableAt: now + 60_000,
      deferredUntilMs: now + 60_000,
      ...(queueName === "outbound-session-generation-v1"
        ? {
            sessionGeneration: {
              agentId: "main",
              storePath: "/test/sessions.json",
              sessionKey: "agent:main:main",
              sessionId: "s1",
              lifecycleRevision: null,
            },
          }
        : {}),
      ...(queueName === COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME
        ? {
            deliveryCompletion: {
              kind: "pending-final" as const,
              commandOwnerReference: null,
              deliveryId: "d1",
              intentId: "i1",
              sessionId: "s1",
              sessionKey: "agent:main:main",
              storePath: "/test/sessions.json",
            },
          }
        : {}),
    };
    upsertDeliveryQueueEntryInDatabase({ queueName, entry }, database);
    expect(getNextDeferredOutboundDeliveryAtMs(stateDir, undefined, now)).toBe(now + 60_000);
  });
});
