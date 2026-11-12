import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { logMessageDispatchStarted, logMessageProcessed } from "../../logging/diagnostic.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/**
 * A Gateway agent message reports its dispatch and processing like channel ingress, under
 * a child of the request trace. Start and finish each record once.
 */
export function createGatewayMessageDiagnostics(params: StartAgentRunExecutionParams) {
  const activeDiagnosticTrace = params.diagnosticTrace ?? getActiveDiagnosticTraceContext();
  const ingressDiagnosticTrace = activeDiagnosticTrace
    ? freezeDiagnosticTraceContext(activeDiagnosticTrace)
    : undefined;
  const gatewayDispatchDiagnosticTrace = ingressDiagnosticTrace
    ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ingressDiagnosticTrace))
    : undefined;
  const gatewayDiagnosticChannel =
    params.delivery.originMessageChannel ?? params.delivery.resolvedChannel ?? "gateway";
  let gatewayMessageStartedAt: number | undefined;
  let gatewayMessageFinished = false;
  const start = () => {
    if (!gatewayDispatchDiagnosticTrace || gatewayMessageStartedAt !== undefined) {
      return;
    }
    gatewayMessageStartedAt = Date.now();
    runWithDiagnosticTraceContext(gatewayDispatchDiagnosticTrace, () =>
      logMessageDispatchStarted({
        channel: gatewayDiagnosticChannel,
        sessionId: params.resolvedSessionId,
        sessionKey: params.resolvedSessionKey,
        source: "gateway.agent",
      }),
    );
  };
  const finish = (outcome: {
    outcome: "completed" | "skipped" | "error";
    reason?: string;
    error?: string;
  }) => {
    if (
      !gatewayDispatchDiagnosticTrace ||
      gatewayMessageStartedAt === undefined ||
      gatewayMessageFinished
    ) {
      return;
    }
    const startedAt = gatewayMessageStartedAt;
    gatewayMessageFinished = true;
    runWithDiagnosticTraceContext(gatewayDispatchDiagnosticTrace, () =>
      logMessageProcessed({
        channel: gatewayDiagnosticChannel,
        sessionId: params.resolvedSessionId,
        sessionKey: params.resolvedSessionKey,
        durationMs: Date.now() - startedAt,
        outcome: outcome.outcome,
        reason: outcome.reason,
        error: outcome.error,
      }),
    );
  };
  return { trace: gatewayDispatchDiagnosticTrace, start, finish };
}
