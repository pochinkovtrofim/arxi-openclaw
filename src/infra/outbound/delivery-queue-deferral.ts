import type { DeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";

/** Keep an unsent prepared batch and its media under queue custody until a future retry. */
export function deferDeliveryBeforePlatformSend(
  id: string,
  retryAtMs: number,
  stateDir: string | undefined,
  claimedAttemptId: string,
  context?: DeliveryQueueStateContext,
  restoreAttemptCount?: number,
): Promise<void> {
  return executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.deferOutbound",
    input: {
      id,
      retryAtMs,
      claimedAttemptId,
      ...(restoreAttemptCount !== undefined ? { restoreAttemptCount } : {}),
    },
  });
}
