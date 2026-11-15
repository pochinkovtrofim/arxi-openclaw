import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { measurePrepStage } from "../../infra/run-prep-stages.js";
import { recordHookPhaseTiming, takeHookPhaseTimings } from "../../plugins/hook-phase-timing.js";
import { CLI_PREP_HANDOFF_STAGE, createCliPrepStages } from "./prep-stages.js";
import type { PreparedCliRunContext } from "./types.js";

const emitted = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock("../../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/diagnostic-events.js")>()),
  emitTrustedDiagnosticEvent: (event: Record<string, unknown>) => emitted.events.push(event),
}));

const STAGE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/u;

function preparedContext(runId: string): PreparedCliRunContext {
  return {
    params: {
      runId,
      sessionId: "session-1",
      sessionKey: "agent:main:test",
      provider: "claude-cli",
      trigger: "user",
      prompt: "private prompt",
      messageChannel: "telegram",
    },
    modelId: "sonnet",
    systemPrompt: "system",
    contextWindowInfo: { tokens: 200_000 },
  } as unknown as PreparedCliRunContext;
}

afterEach(() => {
  vi.restoreAllMocks();
  emitted.events.length = 0;
});

describe("CLI turn preparation stages", () => {
  it("reports the steps the preparation times deep inside a checkpoint", async () => {
    let nowMs = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const stages = createCliPrepStages({ runId: "run-steps", sessionId: "session-1" });
    await stages.within(async () => {
      nowMs += 5;
      stages.mark("mcp-run-admission");
      await measurePrepStage("mcp-requester-resolve", async () => {
        nowMs += 420;
      });
      nowMs += 50;
      stages.mark("mcp-tool-projection");
    });
    stages.handOff({ context: preparedContext("run-steps"), historyMessages: [] });
    const reported = emitted.events.find((event) => event.type === "context.stages") as {
      stages: Array<{ name: string; startedAt: number; endedAt: number }>;
    };
    const step = reported.stages.find((stage) => stage.name === "mcp-requester-resolve");
    expect(step).toEqual({ name: "mcp-requester-resolve", startedAt: 10_005, endedAt: 10_425 });
    expect(reported.stages.every((stage) => STAGE_NAME.test(stage.name))).toBe(true);
  });
  it("reports contiguous stages up to the hand-off with the hook timings, once", () => {
    let nowMs = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const stages = createCliPrepStages({
      runId: "run-1",
      sessionKey: "agent:main:test",
      sessionId: "session-1",
    });
    const steps: Array<[string, number]> = [
      ["run-admission", 5],
      ["before-agent-reply-hook", 20],
      ["session-history-load", 120],
      ["prompt-build-hooks", 640],
      ["mcp-bundle-tools", 90],
      ["system-prompt", 30],
      ["before-agent-run-hooks", 15],
    ];
    for (const [stage, ms] of steps) {
      nowMs += ms;
      stages.mark(stage);
      if (stage === "prompt-build-hooks") {
        recordHookPhaseTiming({
          runId: "run-1",
          phase: "before_prompt_build",
          label: "ro-context#0",
          startedAt: nowMs - 600,
          endedAt: nowMs,
          timedOut: false,
        });
      }
    }
    nowMs += 40;
    const context = preparedContext("run-1");
    stages.handOff({ context, historyMessages: [{ role: "user", content: "hi" }] });
    nowMs += 500;
    // A retried attempt hands off again; the run reports its stages once.
    stages.handOff({ context, historyMessages: [] });

    expect(emitted.events.map((event) => event.type)).toEqual([
      "context.assembled",
      "context.stages",
    ]);
    const [assembled, reported] = emitted.events;
    expect(assembled).toMatchObject({
      runId: "run-1",
      provider: "claude-cli",
      model: "sonnet",
      messageCount: 1,
      promptHooks: { count: 1, timeouts: 0, slowest: "ro-context#0", slowestMs: 600 },
    });
    expect(JSON.stringify(assembled)).not.toContain("private prompt");
    expect(takeHookPhaseTimings("run-1")).toEqual({});

    const placed = reported?.stages as Array<{ name: string; startedAt: number; endedAt: number }>;
    expect(placed.map((stage) => stage.name)).toEqual([
      ...steps.map(([stage]) => stage),
      CLI_PREP_HANDOFF_STAGE,
    ]);
    expect(placed[0]?.startedAt).toBe(10_000);
    for (let index = 1; index < placed.length; index += 1) {
      expect(placed[index]?.startedAt).toBe(placed[index - 1]?.endedAt);
    }
    expect(placed.at(-1)?.endedAt).toBe(10_000 + steps.reduce((sum, [, ms]) => sum + ms, 0) + 40);
    for (const stage of placed) {
      expect(stage.name).toMatch(STAGE_NAME);
    }
    expect(reported).toMatchObject({ runId: "run-1", sessionKey: "agent:main:test" });
    expect(reported?.trace).toMatchObject({
      parentSpanId: (assembled?.trace as { parentSpanId: string } | undefined)?.parentSpanId,
    });
  });

  it("places user-turn and MCP sub-stages in order, contiguous, covering the old windows", () => {
    let nowMs = 5_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const stages = createCliPrepStages({ runId: "run-3" });
    const steps: Array<[string, number]> = [
      ["mcp-tool-auth-store", 40],
      ["mcp-bundle-tools", 60],
      ["before-agent-run-hooks", 15],
      ["user-turn-actor-wait", 1],
      ["user-turn-message-resolve", 12],
      ["user-turn-target-resolve", 8],
      ["user-turn-write", 90],
      ["user-turn-admission", 25],
      ["user-turn-settle", 2],
      ["llm-input-hook", 3],
    ];
    for (const [stage, ms] of steps) {
      nowMs += ms;
      stages.mark(stage);
    }
    stages.handOff({ context: preparedContext("run-3"), historyMessages: [] });
    const reported = emitted.events.find((event) => event.type === "context.stages");
    const placed = reported?.stages as Array<{ name: string; startedAt: number; endedAt: number }>;
    expect(placed.map((stage) => stage.name).slice(0, steps.length)).toEqual(
      steps.map(([stage]) => stage),
    );
    let cursor = 5_000;
    for (const [index, [, ms]] of steps.entries()) {
      expect(placed[index]?.startedAt).toBe(cursor);
      expect(placed[index]?.endedAt).toBe(cursor + ms);
      cursor += ms;
    }
    for (const stage of placed) {
      expect(stage.name).toMatch(STAGE_NAME);
    }
  });

  it("hangs its stage spans directly off the run's own span", () => {
    const runTrace = createDiagnosticTraceContext();
    const stages = runWithDiagnosticTraceContext(runTrace, () =>
      createCliPrepStages({ runId: "run-2" }),
    );
    stages.mark("run-admission");
    stages.handOff({ context: preparedContext("run-2"), historyMessages: [] });
    const reported = emitted.events.find((event) => event.type === "context.stages");
    expect(reported?.trace).toMatchObject({
      traceId: runTrace.traceId,
      parentSpanId: runTrace.spanId,
    });
  });
});
