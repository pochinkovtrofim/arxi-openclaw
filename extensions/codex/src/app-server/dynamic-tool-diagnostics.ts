/**
 * Trusted diagnostics emitted around Codex dynamic tool execution lifecycle.
 */
import {
  emitTrustedDiagnosticEvent,
  hasPendingInternalDiagnosticEvent,
  resolveDiagnosticExecClass,
  type DiagnosticEventPayload,
  type DiagnosticTraceContext,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { CodexDynamicToolCallParams } from "./protocol.js";

type DynamicToolDiagnosticContext = {
  call: CodexDynamicToolCallParams;
  agentId?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
  trace?: DiagnosticTraceContext | undefined;
};

// A fixed per-tool vocabulary, never error prose: anything else is dropped, not truncated.
const CONTENT_FREE_TOOL_ERROR_CODE = /^[a-z_]{1,64}$/u;

/** Returns a tool's failure code only when it is a content-free identifier. */
export function readDynamicToolErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && CONTENT_FREE_TOOL_ERROR_CODE.test(value) ? value : undefined;
}

function diagnosticToolIdentity(params: DynamicToolDiagnosticContext) {
  // Content-free command class only; the arguments themselves never leave here.
  const execClass = resolveDiagnosticExecClass(params.call.tool, params.call.arguments);
  return {
    ...(execClass ? { execClass } : {}),
    agentId: params.agentId,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    trace: params.trace,
    toolName: params.call.tool,
    toolCallId: params.call.callId,
  };
}

export function createCodexDynamicToolDiagnostics(params: DynamicToolDiagnosticContext) {
  const matchesTerminal = (event: DiagnosticEventPayload): boolean => {
    if (
      (event.type !== "tool.execution.completed" &&
        event.type !== "tool.execution.error" &&
        event.type !== "tool.execution.blocked") ||
      event.toolCallId !== params.call.callId ||
      event.toolName !== params.call.tool
    ) {
      return false;
    }
    if (params.runId !== undefined) {
      return event.runId === params.runId;
    }
    if (params.sessionId !== undefined) {
      return event.sessionId === params.sessionId;
    }
    if (params.sessionKey !== undefined) {
      return event.sessionKey === params.sessionKey;
    }
    return (
      event.runId === undefined && event.sessionId === undefined && event.sessionKey === undefined
    );
  };
  const error = (
    durationMs: number,
    terminalReason: "failed" | "cancelled" | "timed_out" = "failed",
    rawErrorCode?: unknown,
  ) => {
    const errorCode = readDynamicToolErrorCode(rawErrorCode);
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...diagnosticToolIdentity(params),
      durationMs,
      errorCategory: "codex_dynamic_tool_error",
      ...(errorCode ? { errorCode } : {}),
      terminalReason,
    });
  };
  return {
    matchesTerminal,
    hasPendingTerminal: () => hasPendingInternalDiagnosticEvent(matchesTerminal),
    started() {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        ...diagnosticToolIdentity(params),
      });
    },
    error,
    terminal(response: CodexDynamicToolRuntimeResponse, durationMs: number) {
      const type = response.diagnosticTerminalType ?? (response.success ? "completed" : "error");
      if (type === "completed") {
        emitTrustedDiagnosticEvent({
          type: "tool.execution.completed",
          ...diagnosticToolIdentity(params),
          durationMs,
        });
      } else if (type === "blocked") {
        emitTrustedDiagnosticEvent({
          type: "tool.execution.blocked",
          ...diagnosticToolIdentity(params),
          deniedReason: "plugin-before-tool-call",
          reason: "Tool call blocked",
        });
      } else {
        error(durationMs, response.diagnosticTerminalReason ?? "failed", response.errorCode);
      }
    },
  };
}
