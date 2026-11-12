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
