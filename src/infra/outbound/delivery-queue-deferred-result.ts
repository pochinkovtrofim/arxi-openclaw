import { assertOutboundHandoffCurrent } from "./deliver-handoff.js";
import { OutboundDeliveryDeferredError, OutboundDeliveryError } from "./deliver-types.js";

type DeferredDeliveryOwner = { defer(retryAtMs: number): void };

export function settlePreDispatchDeliveryError(params: {
  error: unknown;
  platformQueueId?: string;
  queueOwner?: DeferredDeliveryOwner;
  platformSendStarted: boolean;
  deliveredResultCount: number;
  dispatchedPayloadCount: number;
  queuedPostSendState?: unknown;
  assertDirectAdapterHandoff?: () => void;
}):
  | { accepted: true }
  | { accepted: false; propagate: true; error: unknown }
  | { accepted: false; propagate: false; error: unknown } {
  let error = params.error;
  const hasSendEvidence =
    params.deliveredResultCount > 0 ||
    params.dispatchedPayloadCount > 0 ||
    params.queuedPostSendState !== undefined;
  if (error instanceof OutboundDeliveryDeferredError) {
    if (!hasSendEvidence && params.platformQueueId && params.queueOwner) {
      params.queueOwner.defer(error.retryAtMs);
      return { accepted: true };
    }
    if (!hasSendEvidence && params.platformQueueId) {
      return { accepted: false, propagate: true, error };
    }
    if (hasSendEvidence || !params.platformQueueId) {
      error = new Error("Adapter deferred a delivery after platform dispatch began", {
        cause: error,
      });
    }
  }
  if (
    !params.platformSendStarted &&
    params.deliveredResultCount === 0 &&
    params.queuedPostSendState === undefined &&
    !(error instanceof OutboundDeliveryError && error.sentBeforeError)
  ) {
    // Initial handler/bootstrap failures precede every adapter handoff.
    try {
      assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
    } catch (rejection) {
      error = rejection;
    }
  }
  return { accepted: false, propagate: false, error };
}
