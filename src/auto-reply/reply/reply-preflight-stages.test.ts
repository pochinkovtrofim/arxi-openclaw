import { afterEach, expect, it, vi } from "vitest";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";

const emitTrustedDiagnosticEvent = vi.hoisted(() => vi.fn());
vi.mock("../../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/diagnostic-events.js")>()),
  emitTrustedDiagnosticEvent,
}));

import { createReplyPreflightStages } from "./reply-preflight-stages.js";

afterEach(() => {
  vi.useRealTimers();
  emitTrustedDiagnosticEvent.mockClear();
});

it("emits consecutive content-free stages inside the reply's trace", async () => {
  vi.useFakeTimers({ now: 10_000 });
  const trace = createDiagnosticTraceContext();
  runWithDiagnosticTraceContext(trace, () => {
    const stages = createReplyPreflightStages({ startedAt: 7_000, sessionKey: "agent:main:main" });
    stages.mark("prepare");
    vi.advanceTimersByTime(1_500);
    void stages.memoryFlush(async () => {
      vi.advanceTimersByTime(9_000);
    });
  });
  await Promise.resolve();
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
    createReplyPreflightStages({ startedAt: Date.now() }).mark("prepare");
  });
  expect(emitTrustedDiagnosticEvent).not.toHaveBeenCalled();
});

it("closes the pre-run compaction step with the part that ran last", () => {
  vi.useFakeTimers({ now: 10_000 });
  runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () => {
    const stages = createReplyPreflightStages({ startedAt: 10_000 });
    stages.compactionStarted();
    vi.advanceTimersByTime(30_000);
    stages.preflightDone();
  });
  expect(
    emitTrustedDiagnosticEvent.mock.calls.map(([event]) => [event.stage, event.durationMs]),
  ).toEqual([
    ["token_estimate", 0],
    ["compaction", 30_000],
  ]);
});

it("pins the closed stage list", async () => {
  const { REPLY_PREFLIGHT_STAGES } = await import("../../infra/diagnostic-events.js");
  expect([...REPLY_PREFLIGHT_STAGES]).toEqual([
    "gateway_routing",
    "gateway_storage",
    "gateway_content",
    "gateway_session",
    "gateway_admission",
    "gateway_session_write",
    "gateway_delivery",
    "gateway_dispatch",
    "gateway_rpc",
    "command_prepare",
    "admission",
    "prepare",
    "token_estimate",
    "memory_flush",
    "replan",
    "compaction",
    "run_admission",
  ]);
});

it("covers the Gateway's receipt through admission without a gap, one child span each", () => {
  vi.useFakeTimers({ now: 50_000 });
  const trace = createDiagnosticTraceContext();
  runWithDiagnosticTraceContext(trace, () => {
    const stages = createReplyPreflightStages({ startedAt: 49_000 });
    vi.advanceTimersByTime(300);
    stages.mark("gateway_rpc");
    vi.advanceTimersByTime(40);
    stages.mark("command_prepare");
    vi.advanceTimersByTime(5);
    stages.mark("admission");
  });
  const events = emitTrustedDiagnosticEvent.mock.calls.map(([event]) => event);
  expect(events.map((event) => [event.stage, event.durationMs])).toEqual([
    ["gateway_rpc", 1_300],
    ["command_prepare", 40],
    ["admission", 5],
  ]);
  const spans = events.map((event) => event.trace.spanId);
  expect(new Set(spans).size).toBe(3);
  expect(spans).not.toContain(trace.spanId);
  for (const event of events) {
    expect(event.trace).toMatchObject({ traceId: trace.traceId, parentSpanId: trace.spanId });
  }
});

it("closes stages at recorded moments, skipping those out of order or outside the window", () => {
  vi.useFakeTimers({ now: 50_000 });
  const trace = createDiagnosticTraceContext();
  runWithDiagnosticTraceContext(trace, () => {
    const stages = createReplyPreflightStages({ startedAt: 49_000 });
    stages.markAt("gateway_routing", 49_100);
    stages.markAt("gateway_storage", 49_050); // before the open stage began
    stages.markAt("gateway_content", 49_400);
    stages.markAt("gateway_session", 50_500); // in the future
    stages.markAt("gateway_admission", Number.NaN);
    stages.markAt("gateway_dispatch", 49_900);
    stages.mark("gateway_rpc");
  });
  const events = emitTrustedDiagnosticEvent.mock.calls.map(([event]) => event);
  expect(events.map((event) => [event.stage, event.durationMs])).toEqual([
    ["gateway_routing", 100],
    ["gateway_content", 300],
    ["gateway_dispatch", 500],
    ["gateway_rpc", 100],
  ]);
  expect(new Set(events.map((event) => event.trace.spanId)).size).toBe(4);
  for (const event of events) {
    expect(event.trace).toMatchObject({ traceId: trace.traceId, parentSpanId: trace.spanId });
  }
});
