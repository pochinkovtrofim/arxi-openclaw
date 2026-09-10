import {
  formatDiagnosticTraceparent,
  isDiagnosticsEnabled,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { RpcRequest } from "./protocol.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

export function resolveCodexThreadRequestTraceOptions(params: CodexStartOrResumeThreadParams): {
  trace?: RpcRequest["trace"];
} {
  const traceparent =
    isDiagnosticsEnabled(params.params.config) && params.params.diagnosticTrace
      ? formatDiagnosticTraceparent(params.params.diagnosticTrace)
      : undefined;
  return traceparent ? { trace: { traceparent } } : {};
}
