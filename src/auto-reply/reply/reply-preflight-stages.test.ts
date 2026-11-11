import { afterEach, expect, it, vi } from "vitest";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";

const emitTrustedDiagnosticEvent = vi.hoisted(() => vi.fn());
vi.mock("../../infra/diagnostic-events.js", () => ({ emitTrustedDiagnosticEvent }));

import { createReplyPreflightStages } from "./reply-preflight-stages.js";

afterEach(() => {
  vi.useRealTimers();
  emitTrustedDiagnosticEvent.mockClear();
});

it("emits consecutive content-free stages inside the reply's trace", () => {
  vi.useFakeTimers({ now: 10_000 });
  const trace = createDiagnosticTraceContext();
  runWithDiagnosticTraceContext(trace, () => {
    const stage = createReplyPreflightStages({ startedAt: 7_000, sessionKey: "agent:main:main" });
    stage("prepare");
    vi.advanceTimersByTime(1_500);
    stage("token_estimate");
    vi.advanceTimersByTime(9_000);
    stage("memory_flush");
  });
  expect(
    emitTrustedDiagnosticEvent.mock.calls.map(([event]) => [event.stage, event.durationMs]),
  ).toEqual([
    ["prepare", 3_000],
    ["token_estimate", 1_500],
    ["memory_flush", 9_000],
  ]);
  for (const [event] of emitTrustedDiagnosticEvent.mock.calls) {
    expect(event).toMatchObject({
      type: "reply.preflight.stage",
      sessionKey: "agent:main:main",
      trace: { traceId: trace.traceId, parentSpanId: trace.spanId },
    });
  }
});

it("emits nothing outside a traced reply", () => {
  runWithDiagnosticTraceContext(undefined, () => {
    createReplyPreflightStages({ startedAt: Date.now() })("prepare");
  });
  expect(emitTrustedDiagnosticEvent).not.toHaveBeenCalled();
});
