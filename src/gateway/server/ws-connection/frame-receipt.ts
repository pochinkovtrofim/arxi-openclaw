import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayPreflightStep, PreflightStepMoment } from "../../../infra/diagnostic-events.js";

/** Steps between a request frame's receipt and its handler, each named by where it ends. */
export type GatewayFrameStep = Extract<
  GatewayPreflightStep,
  "frame_admission" | "request_authorize" | "handler_prepare"
>;

type GatewayFrameReceipt = { receivedAt: number; steps: PreflightStepMoment[] };

const activeFrameReceipt = new AsyncLocalStorage<GatewayFrameReceipt>();

/**
 * Runs a request frame's handling with the moment it was read off the socket, so a
 * traced turn's clock can start there rather than at its handler (epoch ms).
 */
export function runWithGatewayFrameReceipt<T>(receivedAt: number, run: () => T): T {
  return activeFrameReceipt.run({ receivedAt, steps: [] }, run);
}

/** Records that the current frame finished a step; outside a frame nothing happens. */
export function markGatewayFrameStep(step: GatewayFrameStep): void {
  activeFrameReceipt.getStore()?.steps.push({ step, at: Date.now() });
}

/** The current frame's receipt and the steps it finished so far, or undefined outside one. */
export function readGatewayFrameReceipt():
  | { receivedAt: number; steps: ReadonlyArray<PreflightStepMoment> }
  | undefined {
  const receipt = activeFrameReceipt.getStore();
  return receipt ? { receivedAt: receipt.receivedAt, steps: [...receipt.steps] } : undefined;
}
