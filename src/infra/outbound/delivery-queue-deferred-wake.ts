import {
  type DeliveryQueueStateContext,
  loadDeliveryQueueEntries,
} from "../delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

/** Synchronous suspend snapshot of the earliest semantic provider deferral. */
export function getNextDeferredOutboundDeliveryAtMs(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
  now = Date.now(),
): number | null {
  const deferred = loadDeliveryQueueEntries(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    stateDir,
    "unfinished",
    context,
  )
    .map((entry) => {
      // SAFETY: Entries in the prepared outbound namespace retain the queued-delivery shape.
      return entry as QueuedDelivery;
    })
    .flatMap((entry) => {
      const deferredUntilMs = entry.deferredUntilMs;
      return typeof deferredUntilMs === "number" &&
        Number.isSafeInteger(deferredUntilMs) &&
        deferredUntilMs === entry.availableAt &&
        entry.recoveryState === undefined &&
        entry.producerClaimId === undefined &&
        entry.platformSendAttemptId === undefined &&
        entry.settlement === undefined
        ? [Math.max(now, deferredUntilMs)]
        : [];
    });
  return deferred.length > 0 ? Math.min(...deferred) : null;
}
