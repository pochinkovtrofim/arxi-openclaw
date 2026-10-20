// Gateway RPC handlers for cooperative, host-neutral process suspension.
import {
  ErrorCodes,
  errorShape,
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendResumeParams,
  validateGatewaySuspendStatusParams,
  validateGatewaySuspendHandoffParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronSuspendWakeSnapshot } from "../../cron/service-contract.js";
import { inspectPendingDeliveryQueueDeferrals } from "../../infra/delivery-queue-sqlite.js";
import { waitForGatewayDrain } from "../../infra/gateway-drain.js";
import {
  armGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { getNextDeferredOutboundDeliveryAtMs } from "../../infra/outbound/delivery-queue-deferred-wake.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-namespaces.js";
import { suspendMemorySearchManagersCore } from "../../plugins/memory-runtime.js";
import { closeIdleOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeIdleOpenClawAgentDatabaseExecutions } from "../../state/openclaw-agent-execution.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { createGatewayServerActiveWorkInspectors } from "../server-active-work.js";
import type { GatewayRequestContext } from "./shared-types.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

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

function respondSuspendStatus(
  result: ReturnType<typeof prepareGatewaySuspend> | ReturnType<typeof getGatewaySuspendStatus>,
  context: GatewayRequestContext,
  respond: RespondFn,
  conflictMessage: string,
) {
  if (result.status === "conflict") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, conflictMessage, {
        retryable: true,
        retryAfterMs: Math.max(0, result.expiresAtMs - Date.now()),
        details: { reason: "gateway-suspension-conflict", expiresAtMs: result.expiresAtMs },
      }),
    );
  } else if (result.status === "recovering") {
    respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
  } else {
    if (result.status === "draining") {
      context.logGateway.info(
        `DRAINING activeCount=${result.activeCount} blockers=${result.blockers.map(({ kind, count }) => `${kind}:${count}`).join(",")} holders=${JSON.stringify(result.blockers.map(({ message }) => message))} custody=${result.writeCustody?.some(({ count }) => count > 0) ? "held" : "clear"}`,
      );
    }
    respond(true, result);
  }
}

const SUSPEND_AGENT_DATABASE_CLOSE_TIMEOUT_MS = 5_000;

// Memory indexes closed for a ready suspension reopen when this process resumes.
let pendingMemoryResume: Promise<((params: { cfg: OpenClawConfig }) => void) | undefined> | undefined;

function resumeMemoryAfterSuspension(context: GatewayRequestContext): void {
  const pending = pendingMemoryResume;
  pendingMemoryResume = undefined;
  void pending
    ?.then((resume) => resume?.({ cfg: context.getRuntimeConfig() }))
    .catch((error: unknown) => {
      context.logGateway.warn(`memory resume after suspension failed: ${String(error)}`);
    });
}

/**
 * A ready suspension may end in VM eviction without exit hooks. Closing idle
 * agent databases first leaves clean-close receipts, so the next process skips
 * dead-owner WAL recovery and its full integrity check. Memory managers borrow
 * their agent database for their whole life, so they close first.
 */
async function closeIdleAgentDatabasesForSuspend(context: GatewayRequestContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = (async () => {
    const memory = suspendMemorySearchManagersCore();
    pendingMemoryResume ??= memory.catch(() => undefined);
    await memory;
    const executions = await closeIdleOpenClawAgentDatabaseExecutions();
    const handles = closeIdleOpenClawAgentDatabases();
    // Busy or borrowed owners keep their leases; the next process sees them as dirty.
    context.logGateway.info(
      `idle agent databases closed before suspension: executions closed=${executions.closed} busy=${executions.busy}; handles closed=${handles.closed} borrowed=${handles.borrowed} transaction=${handles.transaction} failed=${handles.failed}`,
    );
  })();
  try {
    await Promise.race([
      close,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          context.logGateway.warn("idle agent database close before suspension is still running");
          resolve();
        }, SUSPEND_AGENT_DATABASE_CLOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    context.logGateway.warn(`idle agent database close before suspension failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  void close.catch(() => {});
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
      commit: params.commit,
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
      resumeScheduling: () => {
        context.cron.resumeScheduling();
        resumeMemoryAfterSuspension(context);
      },
      inspect: createGatewayServerActiveWorkInspectors(context),
      inspectWakeRequirement: () =>
        combineGatewaySuspendWakeSnapshot(context.cron.getSuspendWakeSnapshot()),
      warn: (message) => context.logGateway.warn(message),
    });
    if (result.status === "ready" && params.requireEmptyOutbound === true) {
      let outboundEmpty: boolean;
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
    respondSuspendStatus(
      result,
      context,
      respond,
      "another gateway suspension is already prepared",
    );
  },
  "gateway.suspend.status": async ({ respond, params, context }) => {
    if (!validateGatewaySuspendStatusParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.status"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    // A policy check must let transient final writes settle, without interrupting
    // admitted work or treating a drain lease as authority to stop it.
    const settleDeadline = performance.now() + 15_000;
    await waitForGatewayDrain(
      () => {
        const status = getGatewaySuspendStatus(suspensionId, params.includeLifecycle === true);
        return {
          idle:
            status.status !== "draining" ||
            !status.writeCustody?.some(({ count }) => count > 0) ||
            performance.now() >= settleDeadline,
        };
      },
      15_000,
      { pollMs: 250 },
    );
    let result = getGatewaySuspendStatus(suspensionId, params.includeLifecycle === true);
    if (result.status === "ready") {
      await closeIdleAgentDatabasesForSuspend(context);
      // Lease expiry, replacement, and new writes can race the awaited close.
      result = getGatewaySuspendStatus(suspensionId, params.includeLifecycle === true);
    }
    respondSuspendStatus(result, context, respond, "a different gateway suspension is prepared");
  },
  "gateway.suspend.resume": async ({ respond, params }) => {
    if (!validateGatewaySuspendResumeParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.resume"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    const result = resumeGatewaySuspend(suspensionId);
    if (!result.ok) {
      if (result.reason === "gateway-restarting") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "gateway shutdown is committed"),
        );
        return;
      }
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
