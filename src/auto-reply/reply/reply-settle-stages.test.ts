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

it("closes the pre-run stages once, where the first run attempt starts", () => {
  const onRunStarting = vi.fn();
  const stages = createReplySettleStages({ runId: "run-1", onRunStarting });
  stages.runStarting();
  stages.runEnded();
  // A retried attempt starts again; the pre-run window was already closed.
  stages.runStarting();
  expect(onRunStarting).toHaveBeenCalledTimes(1);
});

it("hands the run's start the steps recorded on the way, then the given ones, once", () => {
  vi.useFakeTimers({ now: 1_000 });
  const onRunStarting = vi.fn();
  const stages = createReplySettleStages({ runId: "run-1", onRunStarting });
  vi.advanceTimersByTime(5);
  stages.runStep("run_params");
  vi.advanceTimersByTime(40);
  stages.runStep("session_admission");
  stages.runStarting([{ step: "attempt_dispatch", at: 1_100 }]);
  stages.runStarting();
  stages.runStep("auth");
  expect(onRunStarting).toHaveBeenCalledTimes(1);
  expect(onRunStarting).toHaveBeenCalledWith([
    { step: "run_params", at: 1_005 },
    { step: "session_admission", at: 1_045 },
    { step: "attempt_dispatch", at: 1_100 },
  ]);
});

it("closes nothing for another run inside the turn, then closes for its own run", () => {
  vi.useFakeTimers({ now: 2_000 });
  const onRunStarting = vi.fn();
  const stages = createReplySettleStages({ runId: "run-1", onRunStarting });
  stages.runStep("run_params");
  vi.advanceTimersByTime(10);
  stages.runStep("run_params");
  // The pre-run memory flush is an embedded run of its own inside the turn's scope.
  stages.runStarting([{ step: "attempt_dispatch", at: 2_005 }], "flush-run");
  expect(onRunStarting).not.toHaveBeenCalled();
  stages.runStarting([], "run-1");
  expect(onRunStarting).toHaveBeenCalledWith([{ step: "run_params", at: 2_010 }]);
});

it("keeps the hand-off steps open until the harness starts, for the turn's own run only", () => {
  const onRunStarting = vi.fn();
  const stages = createReplySettleStages({ runId: "run-1", onRunStarting });
  stages.runHandedOff([{ step: "attempt_handoff", at: 3_000 }], "flush-run");
  stages.runHandedOff(
    [
      { step: "attempt_dispatch", at: 3_010 },
      { step: "attempt_handoff", at: 3_020 },
    ],
    "run-1",
  );
  expect(onRunStarting).not.toHaveBeenCalled();
  stages.runStarting([{ step: "harness_entry", at: 3_200 }], "run-1");
  stages.runHandedOff([{ step: "attempt_handoff", at: 3_300 }], "run-1");
  stages.runStarting([], "run-1");
  expect(onRunStarting).toHaveBeenCalledTimes(1);
  expect(onRunStarting).toHaveBeenCalledWith([
    { step: "attempt_dispatch", at: 3_010 },
    { step: "attempt_handoff", at: 3_020 },
    { step: "harness_entry", at: 3_200 },
  ]);
});
