import {
  type DeliveryQueueStateContext,
  loadDeliveryQueueEntries,
} from "../delivery-queue-sqlite.js";
import { OUTBOUND_EXECUTABLE_QUEUE_NAMES } from "./delivery-queue-namespaces.js";
import { projectOutboundDelivery } from "./delivery-queue-projection.js";

/** Synchronous suspend snapshot of the earliest semantic provider deferral. */
export function getNextDeferredOutboundDeliveryAtMs(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
  now = Date.now(),
): number | null {
  const deferred = OUTBOUND_EXECUTABLE_QUEUE_NAMES.flatMap((queueName) =>
    loadDeliveryQueueEntries(queueName, stateDir, "unfinished", context).map((entry) =>
      projectOutboundDelivery(queueName, entry),
    ),
  ).flatMap((entry) => {
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
