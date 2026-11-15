import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import * as diagnostics from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAttemptPreparationTiming } from "./attempt-preparation-timing.js";

afterEach(() => {
  vi.restoreAllMocks();
  diagnostics.resetDiagnosticEventsForTest();
});

describe("Codex attempt preparation timing", () => {
  it.each([
    { flags: [], stageMs: 5_000, totalMs: 11_000 },
    { flags: ["codex.profiler"], stageMs: 500, totalMs: 1_100 },
  ])(
    "reports slow stages and the native handoff with flags=$flags",
    async ({ flags, stageMs, totalMs }) => {
      let nowMs = 0;
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const params = {
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:test",
        prompt: "private prompt",
        config: { diagnostics: { flags } },
      };
      const preparation = createCodexAttemptPreparationTiming(params);

      await preparation.measure("connection", async () => {
        nowMs += stageMs;
      });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[1]).toEqual({
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:test",
        stage: "connection",
        outcome: "completed",
        totalMs: stageMs,
        stages: [{ name: "connection", durationMs: stageMs, elapsedMs: stageMs }],
      });

      for (const stage of ["tools", "prompt"]) {
        await preparation.measure(stage, async () => {
          nowMs += (totalMs - stageMs) / 2;
        });
      }
      expect(warn).toHaveBeenCalledOnce();
      preparation.ready();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]?.[1]).toMatchObject({
        stage: "native-turn-handoff",
        outcome: "ready",
        totalMs,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(params.prompt);
    },
  );

  it.each([
    { precedingMs: 0, failingMs: 7_000 },
    { precedingMs: 4_000, failingMs: 4_000 },
  ])(
    "retains slow failed preparation ($precedingMs/$failingMs) without replacing its error",
    async ({ precedingMs, failingMs }) => {
      let nowMs = 0;
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const preparation = createCodexAttemptPreparationTiming({
        runId: "run-1",
        sessionId: "session-1",
      });
      const failure = new Error("private failure detail");
      for (const stage of ["connection", "runtime"]) {
        await preparation.measure(stage, () => {
          nowMs += precedingMs;
        });
      }

      await expect(
        preparation.measure("tools", async () => {
          nowMs += failingMs;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        stage: "tools",
        outcome: "error",
        totalMs: precedingMs * 2 + failingMs,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(failure.message);
    },
  );

  it("reports contiguous preparation stages, then the native turn start, with the run's trace", async () => {
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.spyOn(diagnostics, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    const reported: Extract<diagnostics.DiagnosticEventPayload, { type: "context.stages" }>[] = [];
    const unsubscribe = diagnostics.onInternalDiagnosticEvent((event) => {
      if (event.type === "context.stages") {
        reported.push(event);
      }
    });
    const diagnosticTrace = diagnostics.createDiagnosticTraceContext();
    const preparation = createCodexAttemptPreparationTiming({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:test",
      diagnosticTrace,
    });
    const durations = {
      connection: 40,
      runtime: 10,
      tools: 300,
      context: 20,
      prompt: 30,
      "runtime-start": 500,
      "thread-route": 60,
      "turn-request": 5,
    };
    for (const [stage, ms] of Object.entries(durations)) {
      await preparation.measure(stage, () => {
        nowMs += ms;
      });
    }
    nowMs += 2;
    preparation.ready();
    const startTurn = vi.fn(async () => {
      nowMs += 600;
      return "started";
    });
    const timedStart = preparation.timeNativeTurnStart(startTurn);
    await expect(timedStart()).resolves.toBe("started");
    const turnStartEndedAt = nowMs;
    // A retried turn start must not report a second time.
    await timedStart();
    await diagnostics.waitForDiagnosticEventsDrained();
    unsubscribe();

    expect(reported).toHaveLength(2);
    const [prepared, turnStart] = reported;
    expect(prepared?.stages.map((stage) => stage.name)).toEqual([
      ...Object.keys(durations),
      "native-turn-handoff",
    ]);
    // Contiguous: each stage starts where the previous one ended, no gap.
    const spans = prepared?.stages ?? [];
    expect(spans[0]?.startedAt).toBe(1_000);
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]?.startedAt).toBe(spans[index - 1]?.endedAt);
    }
    expect(spans.at(-1)?.endedAt).toBe(1_000 + 40 + 10 + 300 + 20 + 30 + 500 + 60 + 5 + 2);
    expect(turnStart?.stages).toEqual([
      { name: "native-turn-start", startedAt: spans.at(-1)?.endedAt, endedAt: turnStartEndedAt },
    ]);
    for (const event of reported) {
      expect(event.runId).toBe("run-1");
      expect(event.trace?.traceId).toBe(diagnosticTrace.traceId);
      expect(event.trace?.parentSpanId).toBe(diagnosticTrace.spanId);
      for (const stage of event.stages) {
        expect(stage.name).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/u);
      }
    }
  });
});
