import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { DiagnosticSpanBinding } from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, expect, test } from "vitest";
import { createDiagnosticsTraceRuntime } from "./service-traces.js";

const diagnostic = {
  traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  spanId: "bbbbbbbbbbbbbbbb",
};

test("binds a trusted diagnostic lifecycle to the exact span context created by the tracer", async () => {
  const provider = new BasicTracerProvider();
  const bindings: DiagnosticSpanBinding[] = [];
  const runtime = createDiagnosticsTraceRuntime(provider.getTracer("test"), {
    emit: (binding) => bindings.push(binding),
    retire: () => undefined,
  });
  try {
    const span = runtime.spanWithDuration("openclaw.model.call", {}, undefined);
    runtime.trackTrustedSpan(
      {
        type: "model.call.started",
        provider: "openai",
        model: "gpt-5.6",
        callId: "call-1",
        runId: "run-1",
        seq: 1,
        ts: 1,
        trace: diagnostic,
      },
      { trusted: true },
      span,
      "model.call",
    );

    expect(bindings).toEqual([
      {
        diagnostic,
        span: {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          traceFlags: span.spanContext().traceFlags,
        },
        family: "model.call",
      },
    ]);
  } finally {
    await provider.shutdown();
  }
});
