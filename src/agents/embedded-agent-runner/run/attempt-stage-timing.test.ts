// Coverage for embedded attempt startup stage timing diagnostics.
import { isMainThread, threadId } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import {
  createFirstModelRequestStageReporter,
  EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE,
  formatEmbeddedRunStageSummary,
  placeStageTimings,
  shouldWarnEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";

const emitted = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("../../../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/diagnostic-events.js")>()),
  emitTrustedDiagnosticEvent: (event: unknown) => emitted.events.push(event),
}));

describe("embedded run stage timing", () => {
  it("captures stage duration and elapsed time", () => {
    // Stage snapshots carry both local duration and total elapsed time so slow
    // startup logs can identify where time accumulated.
    let clock = 10;
    const tracker = createStageTimingTracker(() => clock);

    clock = 25;
    tracker.mark("workspace");
    clock = 40;
    tracker.mark("tools");
    clock = 45;

    expect(tracker.snapshot()).toEqual({
      totalMs: 35,
      stages: [
        { name: "workspace", durationMs: 15, elapsedMs: 15 },
        { name: "tools", durationMs: 15, elapsedMs: 30 },
      ],
    });
  });

  it("warns only for very slow stage summaries by default", () => {
    expect(
      shouldWarnEmbeddedRunStageSummary({
        totalMs: 9_999,
        stages: [{ name: "auth", durationMs: 4_999, elapsedMs: 4_999 }],
      }),
    ).toBe(false);
    expect(shouldWarnEmbeddedRunStageSummary({ totalMs: 10_000, stages: [] })).toBe(true);
    expect(
      shouldWarnEmbeddedRunStageSummary({
        totalMs: 10,
        stages: [{ name: "auth", durationMs: 5_000, elapsedMs: 5_000 }],
      }),
    ).toBe(true);
  });

  it("supports custom warning thresholds", () => {
    expect(
      shouldWarnEmbeddedRunStageSummary(
        {
          totalMs: 2_000,
          stages: [{ name: "auth", durationMs: 10, elapsedMs: 10 }],
        },
        { totalThresholdMs: 2_000, stageThresholdMs: 1_000 },
      ),
    ).toBe(true);
  });

  it("keeps orchestration startup stages ordered and cumulative", () => {
    let clock = 0;
    const tracker = createStageTimingTracker(() => clock);

    clock = 2;
    tracker.mark("workspace");
    clock = 7;
    tracker.mark("harness-selection");
    clock = 18;
    tracker.mark("prepared-runtime");
    clock = 21;
    tracker.mark("runtime-context");
    tracker.mark("runtime-plugins");

    expect(formatEmbeddedRunStageSummary("startup", tracker.snapshot())).toBe(
      `startup pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} totalMs=21 stages=workspace:2ms@2ms,harness-selection:5ms@7ms,prepared-runtime:11ms@18ms,runtime-context:3ms@21ms,runtime-plugins:0ms@21ms`,
    );
  });

  it("names first-attempt dispatch subspans for slow startup summaries", () => {
    // First-attempt dispatch stages use stable names because logs are compared
    // across provider/runtime startup regressions.
    let clock = 0;
    const tracker = createStageTimingTracker(() => clock);

    clock = 10;
    tracker.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.workspace);
    clock = 40;
    tracker.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.prompt);
    clock = 90;
    tracker.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.runtimePlan);
    clock = 91;
    tracker.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);

    expect(formatEmbeddedRunStageSummary("startup", tracker.snapshot())).toBe(
      `startup pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} totalMs=91 stages=attempt-workspace:10ms@10ms,attempt-prompt:30ms@40ms,attempt-runtime-plan:50ms@90ms,attempt-dispatch:1ms@91ms`,
    );
  });

  it("places checkpoints and nested spans on the wall clock", () => {
    let clock = 1_000;
    const tracker = createStageTimingTracker(() => clock);
    clock = 1_040;
    tracker.mark("skills");
    tracker.measureSync("bundle-tools", () => {
      clock = 1_100;
    });
    clock = 1_130;
    tracker.mark("tool-preparation");

    expect(placeStageTimings(tracker.snapshot(), clock)).toEqual([
      { name: "skills", startedAt: 1_000, endedAt: 1_040 },
      { name: "bundle-tools", startedAt: 1_040, endedAt: 1_100 },
      { name: "tool-preparation", startedAt: 1_040, endedAt: 1_130 },
    ]);
  });

  it("reports the stages once, at the primary model request, ending with that request", () => {
    // Later requests of the same run (tool rounds) would only stretch the last stage.
    emitted.events.length = 0;
    let clock = 5_000;
    const tracker = createStageTimingTracker(() => clock);
    clock = 5_200;
    tracker.mark("prompt-assembly");
    clock = 5_900;
    const runTrace = createDiagnosticTraceContext();
    const report = createFirstModelRequestStageReporter({
      tracker,
      runId: "run-1",
      sessionKey: "agent:main:main",
      runTrace,
      now: () => clock,
    });

    report();
    clock = 9_000;
    report();

    expect(emitted.events).toHaveLength(1);
    expect(emitted.events[0]).toMatchObject({
      type: "context.stages",
      runId: "run-1",
      sessionKey: "agent:main:main",
      stages: [
        { name: "prompt-assembly", startedAt: 5_000, endedAt: 5_200 },
        { name: "model-request", startedAt: 5_200, endedAt: 5_900 },
      ],
      trace: { traceId: runTrace.traceId, parentSpanId: runTrace.spanId },
    });
  });
});
