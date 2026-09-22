import type {
  countFailedDeliveryQueueEntriesInDatabase,
  inspectPendingDeliveryQueueDeferralsInDatabase,
} from "./delivery-queue-sqlite.kernel.js";

export type DeliveryQueueWorkerOperations = {
  "deliveryQueue.countFailed": {
    input: undefined;
    output: ReturnType<typeof countFailedDeliveryQueueEntriesInDatabase>;
  };
  "deliveryQueue.inspectPendingDeferrals": {
    input: Parameters<typeof inspectPendingDeliveryQueueDeferralsInDatabase>[1];
    output: ReturnType<typeof inspectPendingDeliveryQueueDeferralsInDatabase>;
  };
};
