import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GatewayPreflightStep,
  PreflightStepMoment,
} from "../../../infra/diagnostic-events.js";

/** Steps between a request frame's receipt and its handler, each named by where it ends. */
export type GatewayFrameStep = Extract<
  GatewayPreflightStep,
  | "frame_admission"
  | "authorize_projection"
  | "authorize_profile"
  | "authorize_startup_wait"
  | "request_authorize"
  | "handler_prepare"
>;

/**
 * When one request frame was read off its socket (epoch ms) and the steps of its
 * dispatch finished so far. It travels with that request's options only, so work the
 * handler starts, in-process requests included, never inherits it.
 */
export type GatewayFrameReceipt = { readonly receivedAt: number; steps: PreflightStepMoment[] };

const frameReceivedAt = new AsyncLocalStorage<number>();

/** Runs a frame's handling with the moment it was read off the socket. */
export function runWithGatewayFrameReceipt<T>(receivedAt: number, run: () => T): T {
  return frameReceivedAt.run(receivedAt, run);
}

/** The receipt of the frame whose request is being dispatched now, for its options. */
export function takeGatewayFrameReceipt(): GatewayFrameReceipt | undefined {
  const receivedAt = frameReceivedAt.getStore();
  return receivedAt === undefined ? undefined : { receivedAt, steps: [] };
}

/** Records that a frame's request finished a step; a request without a frame records nothing. */
export function markGatewayFrameStep(
  receipt: GatewayFrameReceipt | undefined,
  step: GatewayFrameStep,
): void {
  receipt?.steps.push({ step, at: Date.now() });
}
