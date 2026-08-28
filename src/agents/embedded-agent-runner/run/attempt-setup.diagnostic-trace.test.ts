import { describe, expect, it } from "vitest";
import { runWithDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { startEmbeddedAttemptDiagnostics } from "./attempt-setup.js";

describe("startEmbeddedAttemptDiagnostics trace ownership", () => {
  it("prefers the explicitly retained ingress trace over an ambient wake trace", () => {
    const ingressTrace = {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: "01",
    } as const;
    const wakeTrace = {
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: "01",
    } as const;

    const diagnostics = runWithDiagnosticTraceContext(wakeTrace, () =>
      startEmbeddedAttemptDiagnostics({
        diagnosticTrace: ingressTrace,
        runId: "run-explicit-trace",
        provider: "openai",
        modelId: "gpt-test",
        trigger: "user",
      } as never),
    );

    expect(diagnostics.diagnosticTrace).toEqual(ingressTrace);
    expect(diagnostics.runTrace).toMatchObject({
      traceId: ingressTrace.traceId,
      parentSpanId: ingressTrace.spanId,
    });
  });
});
