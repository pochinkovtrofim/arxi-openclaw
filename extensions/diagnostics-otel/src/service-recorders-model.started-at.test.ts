import { expect, test } from "vitest";
import { createModelRecorders } from "./service-recorders-model.js";

function recordStart(event: { ts: number; startedAt?: number }) {
  const starts: unknown[] = [];
  const span = { spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16) }) };
  const recorders = createModelRecorders({
    tracesEnabled: true,
    getTrackedInternalOrTrustedSpan: () => undefined,
    addRunAttrs: () => undefined,
    activeTrustedParentContext: () => undefined,
    spanWithDuration: (_name: string, _attrs: unknown, _duration: unknown, options: { startTimeMs?: number }) => {
      starts.push(options.startTimeMs);
      return span;
    },
    trackTrustedSpan: (_event: unknown, _metadata: unknown, tracked: typeof span) => tracked,
  } as never);
  recorders.recordModelCallStarted(
    {
      type: "model.call.started",
      provider: "anthropic",
      model: "claude-test",
      callId: "call-1",
      runId: "run-1",
      seq: 1,
      ...event,
    },
    { trusted: true },
  );
  return starts[0];
}

test("a model call span starts when its request began, not when its started event arrived", () => {
  expect(recordStart({ ts: 6_833, startedAt: 5_154 })).toBe(5_154);
  expect(recordStart({ ts: 6_833 })).toBe(6_833);
  // A start after the event, or not a time at all, is not believed.
  expect(recordStart({ ts: 6_833, startedAt: 7_000 })).toBe(6_833);
  expect(recordStart({ ts: 6_833, startedAt: 0 })).toBe(6_833);
});
