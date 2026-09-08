import { trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  onDiagnosticSpanBinding,
  resetDiagnosticEventsForTest,
  type DiagnosticSpanBindingEvent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  emitRealSdkSignals,
  startOtelService,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
let provider: BasicTracerProvider;
let originalPreloaded: string | undefined;

beforeEach(() => {
  resetDiagnosticEventsForTest();
  originalPreloaded = process.env[PRELOAD_ENV];
  process.env[PRELOAD_ENV] = "1";
  provider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await stopStartedOtelServices();
  await provider.shutdown();
  trace.disable();
  if (originalPreloaded === undefined) {
    delete process.env[PRELOAD_ENV];
  } else {
    process.env[PRELOAD_ENV] = originalPreloaded;
  }
  resetDiagnosticEventsForTest();
});

test("emits trusted lifecycle bindings through the service capability", async () => {
  const events: DiagnosticSpanBindingEvent[] = [];
  const stop = onDiagnosticSpanBinding((event) => events.push(event));
  try {
    const { service, ctx } = await startOtelService({ traces: true, metrics: false, logs: false });
    const runTrace = await emitRealSdkSignals("span-binding");
    await service.stop?.(ctx);

    const bindings = events.filter(
      (event): event is Extract<DiagnosticSpanBindingEvent, { kind: "binding" }> =>
        event.kind === "binding",
    );
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({
            diagnostic: expect.objectContaining({
              traceId: runTrace.traceId,
              spanId: runTrace.spanId,
            }),
            family: "run",
          }),
        }),
      ]),
    );
    for (const event of bindings) {
      expect(event.binding.span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(event.binding.span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(event.binding.span.traceFlags).toBeGreaterThanOrEqual(0);
      expect(event.binding.span.traceFlags).toBeLessThanOrEqual(255);
    }
    expect(events.at(-1)).toMatchObject({ kind: "retired" });
  } finally {
    stop();
  }
});
