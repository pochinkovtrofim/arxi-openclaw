import { describe, expect, it, vi } from "vitest";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";
import { runWithGatewayFrameReceipt, takeGatewayFrameReceipt } from "./frame-receipt.js";
// Compile the real router so dispatch reaches the handler without lazy loading.
import "../../server-methods.js";

function dispatchHealth(frameReceipt?: ReturnType<typeof takeGatewayFrameReceipt>) {
  let seen: GatewayRequestHandlerOptions | undefined;
  const handler = vi.fn<GatewayRequestHandler>((options) => {
    seen = options;
    options.respond(true);
  });
  const harness = createDispatchTestHarness({ extraHandlers: { health: handler } });
  const dispatched = harness.dispatcher.dispatch(
    { type: "req", id: "frame-receipt", method: "health", params: {} },
    createOperatorWsClient(),
    frameReceipt,
  );
  return dispatched.then(() => {
    expect(handler).toHaveBeenCalledOnce();
    return seen;
  });
}

describe("frame receipt through the authenticated dispatcher", () => {
  it("hands a wire request's receipt and dispatch steps to its handler", async () => {
    const receivedAt = Date.now() - 50;
    const frameReceipt = runWithGatewayFrameReceipt(receivedAt, takeGatewayFrameReceipt);
    const seen = await dispatchHealth(frameReceipt);
    expect(seen?.frameReceipt).toBe(frameReceipt);
    expect(frameReceipt?.steps.map(({ step }) => step)).toEqual([
      "frame_admission",
      "authorize_profile",
      "authorize_session_facts",
      "request_authorize",
      "handler_prepare",
    ]);
    let cursor = receivedAt;
    for (const { at } of frameReceipt?.steps ?? []) {
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at;
    }
  });

  it("gives a request without a frame no receipt, even inside a frame's work", async () => {
    // Connect-time work such as the model catalog dispatches under the connect frame.
    const seen = await runWithGatewayFrameReceipt(Date.now() - 60_000, () => dispatchHealth());
    expect(seen?.frameReceipt).toBeUndefined();
  });
});
