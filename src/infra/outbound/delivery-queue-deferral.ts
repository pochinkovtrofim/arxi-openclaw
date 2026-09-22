import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  type DeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
} from "../delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { deferDeliveryAttemptBeforeDispatchInDatabase } from "./delivery-queue-storage.kernel.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

/** Clear a one-time provider deferral once an actual delivery attempt starts or settles. */
export function clearDeliveryDeferral(entry: QueuedDelivery): QueuedDelivery {
  return { ...entry, availableAt: undefined, deferredUntilMs: undefined };
}

/** Keep an unsent prepared batch and its media under queue custody until a future retry. */
export function deferDeliveryBeforePlatformSend(
  id: string,
  retryAtMs: number,
  stateDir: string | undefined,
  claimedAttemptId: string,
  context?: DeliveryQueueStateContext,
  restoreAttemptCount?: number,
): void {
  runOpenClawStateWriteTransaction(
    (database) =>
      deferDeliveryAttemptBeforeDispatchInDatabase(database, {
        id,
        retryAtMs,
        claimedAttemptId,
        ...(restoreAttemptCount !== undefined ? { restoreAttemptCount } : {}),
      }),
    { env: resolveDeliveryQueueStateEnv(stateDir, context) },
    { operationLabel: `defer owned ${OUTBOUND_DELIVERY_QUEUE_NAME} delivery` },
  );
}
