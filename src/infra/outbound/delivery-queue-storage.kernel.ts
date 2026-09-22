import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { transitionOwnedDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-claim.kernel.js";
import { upsertDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

/** Restore the exact pre-attempt row while its original owner still holds custody. */
export function restoreDeliveryAttemptBeforeDispatchInDatabase(
  database: OpenClawStateDatabase,
  entry: QueuedDelivery,
  reservedAttemptCount: number,
  claimedAttemptId?: string,
): void {
  const restored = transitionOwnedDeliveryQueueEntryInDatabase(
    database,
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: entry.id,
      platformSendAttemptId: claimedAttemptId ?? null,
    },
    (currentRow) => {
      // SAFETY: The claimed pending row belongs to the prepared outbound namespace.
      const current = currentRow as QueuedDelivery;
      if (current.attemptCount !== reservedAttemptCount) {
        throw new Error(`Delivery attempt reservation changed before rollback: ${entry.id}`);
      }
      const restoredEntry: QueuedDelivery = {
        ...current,
        attemptCount: entry.attemptCount,
        availableAt: entry.availableAt,
        producerClaimId: entry.producerClaimId,
        platformSendAttemptId: entry.platformSendAttemptId,
        platformSendStartedAt: entry.platformSendStartedAt,
        effectiveReplyToId: entry.effectiveReplyToId,
        recoveryState: entry.recoveryState,
      };
      upsertDeliveryQueueEntryInDatabase(
        {
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          entry: restoredEntry,
        },
        database,
      );
    },
  );
  if (!restored) {
    throw new Error(`Delivery platform claim was lost: ${entry.id}`);
  }
}

/** Release an exact pre-dispatch owner while retaining the durable payload for later. */
export function deferDeliveryAttemptBeforeDispatchInDatabase(
  database: OpenClawStateDatabase,
  params: {
    id: string;
    retryAtMs: number;
    claimedAttemptId: string;
    restoreAttemptCount?: number;
  },
): void {
  const deferred = transitionOwnedDeliveryQueueEntryInDatabase(
    database,
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: params.id,
      platformSendAttemptId: params.claimedAttemptId,
    },
    (currentRow) => {
      // SAFETY: The claimed row belongs to the prepared outbound namespace.
      const current = currentRow as QueuedDelivery;
      if (current.recoveryState === "unknown_after_send" || current.settlement) {
        throw new Error(`Delivery already crossed the platform boundary: ${params.id}`);
      }
      if (
        params.restoreAttemptCount !== undefined &&
        current.attemptCount !== params.restoreAttemptCount + 1
      ) {
        throw new Error(`Delivery attempt reservation changed before deferral: ${params.id}`);
      }
      upsertDeliveryQueueEntryInDatabase(
        {
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          entry: {
            ...current,
            ...(params.restoreAttemptCount !== undefined
              ? { attemptCount: params.restoreAttemptCount }
              : {}),
            availableAt: params.retryAtMs,
            deferredUntilMs: params.retryAtMs,
            producerClaimId: undefined,
            platformSendAttemptId: undefined,
            platformSendStartedAt: undefined,
            recoveryState: undefined,
          },
        },
        database,
      );
    },
  );
  if (!deferred) {
    throw new Error(`Delivery platform claim was lost: ${params.id}`);
  }
}
