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

import { REPLY_SETTLE_STAGES } from "../../infra/diagnostic-events.js";
import {
  createReplySettleStages,
  getReplySettleStages,
  runWithReplySettleStages,
} from "./reply-settle-stages.js";

afterEach(() => {
  vi.useRealTimers();
  emitTrustedDiagnosticEvent.mockClear();
});

const emitted = () => emitTrustedDiagnosticEvent.mock.calls.map(([event]) => event);

it("pins the closed stage list", () => {
  expect([...REPLY_SETTLE_STAGES]).toEqual([
    "binding",
    "session_store",
    "transcript",
    "delivery_marker",
    "compaction",
    "before_delivery",
    "send",
  ]);
});

function runTurn(stages: ReturnType<typeof createReplySettleStages>, steps: [string, number][]) {
  stages.runEnded();
  for (const [stage, ms] of steps) {
    vi.advanceTimersByTime(ms);
    stages.mark(stage as (typeof REPLY_SETTLE_STAGES)[number]);
  }
}

it("times every stage from run end to hand-off, in order, each on its own child span", () => {
  vi.useFakeTimers({ now: 10_000 });
  const trace = createDiagnosticTraceContext();
  const steps: [string, number][] = [
    ["binding", 40],
    ["session_store", 120],
    ["transcript", 300],
    ["delivery_marker", 80],
    ["compaction", 6_000],
    ["before_delivery", 15],
    ["send", 250],
  ];
  runWithDiagnosticTraceContext(trace, () => {
    runTurn(createReplySettleStages({ runId: "run-1", sessionKey: "agent:main:main" }), steps);
  });
  const events = emitted();
  expect(events.map((event) => [event.stage, event.durationMs])).toEqual(steps);
  expect(events.map((event) => event.stage)).toEqual([...REPLY_SETTLE_STAGES]);
  // No gap: the stages add up to the whole window.
  expect(events.reduce((sum, event) => sum + event.durationMs, 0)).toBe(6_805);
  const spans = events.map((event) => event.trace.spanId);
  expect(new Set(spans).size).toBe(events.length);
  expect(spans).not.toContain(trace.spanId);
  for (const event of events) {
    expect(event).toMatchObject({
      type: "reply.settle.stage",
      runId: "run-1",
      sessionKey: "agent:main:main",
      trace: { traceId: trace.traceId, parentSpanId: trace.spanId },
    });
  }
});

it("also times an embedded turn whose steps are instant", () => {
  vi.useFakeTimers({ now: 10_000 });
  runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () => {
    runTurn(createReplySettleStages({}), [
      ["binding", 5],
      ["session_store", 20],
      ["transcript", 0],
      ["delivery_marker", 10],
      ["compaction", 0],
      ["before_delivery", 0],
      ["send", 190],
    ]);
  });
  expect(emitted().map((event) => event.durationMs)).toEqual([5, 20, 0, 10, 0, 0, 190]);
});

it("emits nothing before the run ended, after the hand-off, or outside a traced turn", () => {
  vi.useFakeTimers({ now: 10_000 });
  runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () => {
    const stages = createReplySettleStages({});
    stages.mark("binding");
    expect(emitted()).toHaveLength(0);
    runTurn(stages, [["send", 10]]);
    stages.mark("send");
    expect(emitted()).toHaveLength(1);
  });
  emitTrustedDiagnosticEvent.mockClear();
  runWithDiagnosticTraceContext(undefined, () => {
    runTurn(createReplySettleStages({}), [["send", 10]]);
  });
  expect(emitted()).toHaveLength(0);
});

it("restarts the clock when a later run attempt ends", () => {
  vi.useFakeTimers({ now: 10_000 });
  runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () => {
    const stages = createReplySettleStages({});
    stages.runEnded();
    vi.advanceTimersByTime(9_000);
    runTurn(stages, [["binding", 7]]);
  });
  expect(emitted().map((event) => event.durationMs)).toEqual([7]);
});

it("binds the stages for the code that runs inside the turn", async () => {
  const stages = createReplySettleStages({});
  expect(getReplySettleStages()).toBeUndefined();
  await runWithReplySettleStages(stages, async () => {
    await Promise.resolve();
    expect(getReplySettleStages()).toBe(stages);
  });
});
