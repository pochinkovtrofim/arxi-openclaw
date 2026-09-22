import {
  countChannelIngressQueuePressure,
  countFailedChannelIngressQueueEntries,
} from "../../channels/message/ingress-queue-health.js";
import {
  captureDeliveryQueueStateContext,
  countFailedDeliveryQueueEntries,
  inspectPendingDeliveryQueueDeferrals,
  type DeliveryQueueStateContext,
} from "../../infra/delivery-queue-sqlite.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-namespaces.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const healthLog = createSubsystemLogger("health");

const debugHealth = (message: string, error: unknown) => {
  if (isDiagnosticFlagEnabled("health")) {
    healthLog.info(message, { error: formatErrorMessage(error) });
  }
};

async function readQueueHealth<T>(message: string, read: () => T[] | Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    debugHealth(message, error);
    return [];
  }
}

type DeliveryQueueHealthContext = { stateContext: DeliveryQueueStateContext } | { error: unknown };

export function captureDeliveryQueueHealthContext(): DeliveryQueueHealthContext {
  try {
    return { stateContext: captureDeliveryQueueStateContext() };
  } catch (error) {
    return { error };
  }
}

/** Builds redacted inbound pressure and dead-letter health for gateway snapshots. */
export async function buildDeliveryQueueHealthSummary(
  cachedIngressPressure?: ReturnType<typeof countChannelIngressQueuePressure>,
  context: DeliveryQueueHealthContext = captureDeliveryQueueHealthContext(),
) {
  // Queue health reads are diagnostic; a storage failure must not take the
  // gateway health endpoint down with it.
  const failed = await readQueueHealth("outbound delivery queue health read failed", () => {
    if ("error" in context) {
      throw context.error;
    }
    return countFailedDeliveryQueueEntries(undefined, context.stateContext);
  });
  const outbound = await (async () => {
    try {
      if ("error" in context) {
        throw context.error;
      }
      return {
        complete: true as const,
        ...(await inspectPendingDeliveryQueueDeferrals(
          OUTBOUND_DELIVERY_QUEUE_NAME,
          Date.now(),
          undefined,
          context.stateContext,
        )),
      };
    } catch (error) {
      debugHealth("outbound delivery queue rollback inventory read failed", error);
      return { complete: false as const };
    }
  })();
  const ingressFailed = await readQueueHealth(
    "channel ingress failed queue health read failed",
    countFailedChannelIngressQueueEntries,
  );
  const ingressPressure =
    cachedIngressPressure ??
    (await readQueueHealth(
      "channel ingress pressure health read failed",
      countChannelIngressQueuePressure,
    ));

  return {
    failed,
    outbound,
    ...(ingressFailed.length > 0 ? { ingressFailed } : {}),
    ...(ingressPressure.length > 0 ? { ingressPressure } : {}),
  };
}
