// Gateway RPC handlers for cooperative, host-neutral process suspension.
import {
  ErrorCodes,
  errorShape,
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendResumeParams,
  validateGatewaySuspendStatusParams,
  validateGatewaySuspendHandoffParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { CronSuspendWakeSnapshot } from "../../cron/service-contract.js";
import { inspectPendingDeliveryQueueDeferrals } from "../../infra/delivery-queue-sqlite.js";
import {
  armGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { getNextDeferredOutboundDeliveryAtMs } from "../../infra/outbound/delivery-queue-deferred-wake.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-namespaces.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { createGatewayServerActiveWorkInspectors } from "../server-active-work.js";
import type { GatewayRequestHandlers } from "./types.js";

function invalidParams(method: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params`);
}

function schedulerRecoveryError(retryAfterMs: number) {
  return errorShape(ErrorCodes.UNAVAILABLE, "gateway scheduler recovery is pending", {
    retryable: true,
    retryAfterMs,
    details: { reason: "scheduler-resume-failed" },
  });
}

function outboundRollbackPreflightError() {
  return errorShape(ErrorCodes.UNAVAILABLE, "gateway suspension preflight is unavailable", {
    retryable: true,
    retryAfterMs: 1_000,
    details: { reason: "gateway-suspension-preflight-failed" },
  });
}

export function combineGatewaySuspendWakeSnapshot(
  cron: CronSuspendWakeSnapshot,
  inspectDeferredDelivery = getNextDeferredOutboundDeliveryAtMs,
): CronSuspendWakeSnapshot {
  if (!cron.complete) {
    return cron;
  }
  try {
    const deliveryWakeAtMs = inspectDeferredDelivery();
    return {
      complete: true,
      nextWakeAtMs:
        deliveryWakeAtMs === null
          ? cron.nextWakeAtMs
          : cron.nextWakeAtMs === null
            ? deliveryWakeAtMs
            : Math.min(cron.nextWakeAtMs, deliveryWakeAtMs),
    };
  } catch {
    // A missing queue snapshot must not turn durable timed work into external-event-only sleep.
    return { complete: false };
  }
}

export const suspendHandlers: GatewayRequestHandlers = {
  "gateway.suspend.handoff": ({ respond, params, context }) => {
    if (!validateGatewaySuspendHandoffParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.handoff"));
      return;
    }
    if (
      params.target.pid !== process.pid ||
      params.target.processInstanceId !== getGatewayProcessInstanceId()
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "gateway process changed after preflight"),
      );
      return;
    }
    const owner = context.hostLifecycle?.externalRestart;
    if (!owner) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "gateway host does not own process exit"),
      );
      return;
    }
    const result = armGatewaySuspendHandoff({
      suspensionId: params.suspensionId.trim(),
      owner,
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, result.error));
      return;
    }
    respond(true, result.value);
  },
  "gateway.suspend.prepare": async ({ respond, params, context }) => {
    if (!validateGatewaySuspendPrepareParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.prepare"));
      return;
    }
    const requestId = params.requestId.trim();
    const result = prepareGatewaySuspend({
      requestId,
      terminalPolicy: params.terminalPolicy ?? "preserve",
      ...(params.drain === true ? { drain: true } : {}),
      pauseScheduling: () => context.cron.pauseScheduling(),
      resumeScheduling: () => context.cron.resumeScheduling(),
      inspect: createGatewayServerActiveWorkInspectors(context),
      inspectWakeRequirement: () =>
        combineGatewaySuspendWakeSnapshot(context.cron.getSuspendWakeSnapshot()),
      warn: (message) => context.logGateway.warn(message),
    });
    if (result.status === "conflict") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "another gateway suspension is already prepared", {
          retryable: true,
          retryAfterMs: Math.max(0, result.expiresAtMs - Date.now()),
          details: { reason: "gateway-suspension-conflict", expiresAtMs: result.expiresAtMs },
        }),
      );
      return;
    }
    if (result.status === "recovering") {
      respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
      return;
    }
    if (result.status === "ready" && params.requireEmptyOutbound === true) {
      let outboundEmpty = false;
      try {
        const inventory = await inspectPendingDeliveryQueueDeferrals(
          OUTBOUND_DELIVERY_QUEUE_NAME,
          Date.now(),
        );
        const status = getGatewaySuspendStatus(result.suspensionId);
        outboundEmpty =
          inventory.pendingCount === 0 &&
          status.status === "ready" &&
          status.expiresAtMs > Date.now();
      } catch {
        outboundEmpty = false;
      }
      if (!outboundEmpty) {
        resumeGatewaySuspend(result.suspensionId);
        respond(false, undefined, outboundRollbackPreflightError());
        return;
      }
    }
    respond(true, result);
  },
  "gateway.suspend.status": async ({ respond, params }) => {
    if (!validateGatewaySuspendStatusParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.status"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    const result = getGatewaySuspendStatus(suspensionId);
    if (result.status === "conflict") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "a different gateway suspension is prepared", {
          retryable: true,
          retryAfterMs: Math.max(0, result.expiresAtMs - Date.now()),
          details: { reason: "gateway-suspension-conflict", expiresAtMs: result.expiresAtMs },
        }),
      );
      return;
    }
    if (result.status === "recovering") {
      respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
      return;
    }
    respond(true, result);
  },
  "gateway.suspend.resume": async ({ respond, params }) => {
    if (!validateGatewaySuspendResumeParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.resume"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    const result = resumeGatewaySuspend(suspensionId);
    if (!result.ok) {
      if (result.reason === "scheduler-resume-failed") {
        respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "gateway suspension id does not match"),
      );
      return;
    }
    respond(true, result);
  },
};
