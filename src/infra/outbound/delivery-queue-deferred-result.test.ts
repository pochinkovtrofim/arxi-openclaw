import { describe, expect, it } from "vitest";
import { OutboundDeliveryDeferredError } from "./deliver-types.js";
import { settlePreDispatchDeliveryError } from "./delivery-queue-deferred-result.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("settlePreDispatchDeliveryError for an unqueued deferral", () => {
  it("tells the agent the send was not sent, until when it is held, and what to do next", async () => {
    const retryAtMs = Date.now() + 3_600_000;
    const deferral = new OutboundDeliveryDeferredError(retryAtMs);

    const settled = await settlePreDispatchDeliveryError({
      error: deferral,
      platformQueueId: undefined,
      platformSendStarted: false,
      deliveredResultCount: 0,
      dispatchedPayloadCount: 0,
    });

    expect(settled.accepted).toBe(false);
    const message = errorMessage(!settled.accepted ? settled.error : undefined);
    const retryAt = new Date(retryAtMs).toISOString();
    expect(message).toBe(
      `Not sent: this message is held until ${retryAt} and was not queued, so it will not be sent later on its own. ` +
        "If this run's reply is delivered, include the message there; otherwise send it again after that time.",
    );
    expect(!settled.accepted && (settled.error as Error).cause).toBe(deferral);
  });

  it("keeps the dispatch-began failure once a result was delivered", async () => {
    const settled = await settlePreDispatchDeliveryError({
      error: new OutboundDeliveryDeferredError(Date.now() + 3_600_000),
      platformQueueId: undefined,
      platformSendStarted: false,
      deliveredResultCount: 1,
      dispatchedPayloadCount: 0,
    });

    expect(settled.accepted).toBe(false);
    expect(errorMessage(!settled.accepted ? settled.error : undefined)).toBe(
      "Adapter deferred a delivery after platform dispatch began",
    );
  });
});
