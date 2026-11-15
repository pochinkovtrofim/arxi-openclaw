// Verifies Claude CLI model diagnostics stay listener-gated and memory-bounded.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DiagnosticEventPayload,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { CliOutput } from "../cli-output-contracts.js";
import {
  CLI_LANE_QUEUE_STAGE,
  CLI_PROCESS_START_STAGE,
  createClaudeCliModelCallDiagnostics,
} from "./model-call-diagnostics.js";
import type { PreparedCliRunContext } from "./types.js";

const CONTENT_LIMIT_BYTES = 128 * 1024;

function createContext(): PreparedCliRunContext {
  return {
    backendResolved: { id: "claude-cli", modelProvider: "anthropic" },
    contextWindowInfo: undefined,
    normalizedModel: "claude-test",
    params: {
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            traces: true,
            captureContent: true,
          },
        },
      },
      runId: "claude-diagnostics-test",
      agentId: "claude-diagnostics-agent",
      sessionId: "session-test",
    },
  } as PreparedCliRunContext;
}

function createOutputDiagnostics(captureOutputMessages: (messages: unknown) => void) {
  const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if (event.type === "model.call.completed") {
      captureOutputMessages(privateData.modelContent?.outputMessages);
    }
  });
  const diagnostics = expectDefined(
    createClaudeCliModelCallDiagnostics({
      context: createContext(),
      prompt: "hello",
      transport: "stdio",
    }),
    "Claude CLI diagnostics",
  );
  return { diagnostics, stop };
}

describe("Claude CLI model-call diagnostics", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("does not create diagnostics without an active event listener", () => {
    expect(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
    ).toBeUndefined();
  });

  it("bounds large prompt and assistant content during a burst", async () => {
    let completedPrivateData: DiagnosticEventPrivateData | undefined;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        completedPrivateData = privateData;
      }
    });
    const largeText = "€".repeat(256 * 1024);
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: largeText,
        systemPrompt: largeText,
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    for (let index = 0; index < 250; index += 1) {
      diagnostics.observeAssistantMessage({
        content: [{ type: "text", text: `${index}:${largeText}` }],
      });
    }
    diagnostics.emitCompleted({ text: "done" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const modelContent = expectDefined(completedPrivateData?.modelContent, "model content");
    const inputJson = JSON.stringify(modelContent.inputMessages);
    const outputJson = JSON.stringify(modelContent.outputMessages);
    expect(Buffer.byteLength(inputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES + 256);
    expect(Buffer.byteLength(modelContent.systemPrompt ?? "", "utf8")).toBeLessThanOrEqual(
      CONTENT_LIMIT_BYTES,
    );
    expect(Buffer.byteLength(outputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES);
    expect(outputJson).toContain("...(truncated)");
  });

  it("bounds serialized escaped content across many envelopes", async () => {
    let outputMessages: unknown;
    const { diagnostics, stop } = createOutputDiagnostics((messages) => {
      outputMessages = messages;
    });

    diagnostics.emitStarted();
    for (let index = 0; index < 199; index += 1) {
      diagnostics.observeAssistantMessage({ content: `part-${index}:\u0000`.repeat(100) });
    }
    diagnostics.emitCompleted({ text: "done" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    expect(Buffer.byteLength(JSON.stringify(outputMessages), "utf8")).toBeLessThanOrEqual(
      CONTENT_LIMIT_BYTES,
    );
  });

  it("keeps fallback response text when prior non-text envelopes fill the limit", async () => {
    let outputMessages: unknown;
    const { diagnostics, stop } = createOutputDiagnostics((messages) => {
      outputMessages = messages;
    });

    diagnostics.emitStarted();
    for (let index = 0; index < 200; index += 1) {
      diagnostics.observeAssistantMessage({
        content: [{ type: "thinking", thinking: `reason-${index}` }],
      });
    }
    diagnostics.emitCompleted({ text: "final visible answer" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    expect(outputMessages).toHaveLength(200);
    expect(JSON.stringify(outputMessages)).toContain("final visible answer");
    expect(JSON.stringify(outputMessages)).toContain("...(truncated)");
  });

  it("keeps fallback response text when non-text content fills the byte budget", async () => {
    let outputMessages: unknown;
    const { diagnostics, stop } = createOutputDiagnostics((messages) => {
      outputMessages = messages;
    });

    diagnostics.emitStarted();
    diagnostics.observeAssistantMessage({
      content: [{ type: "thinking", thinking: "€".repeat(256 * 1024) }],
    });
    diagnostics.emitCompleted({ text: "final visible answer" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const outputJson = JSON.stringify(outputMessages);
    expect(outputJson).toContain("final visible answer");
    expect(outputJson).toContain("...(truncated)");
    expect(Buffer.byteLength(outputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES + 512);
  });

  it("keeps the fallback reserve after empty text content", async () => {
    let outputMessages: unknown;
    const { diagnostics, stop } = createOutputDiagnostics((messages) => {
      outputMessages = messages;
    });

    diagnostics.emitStarted();
    diagnostics.observeAssistantMessage({ content: "" });
    diagnostics.observeAssistantMessage({
      content: Array.from({ length: 200 }, (_, index) => ({
        type: "thinking",
        thinking: `reason-${index}`,
      })),
    });
    diagnostics.emitCompleted({ text: "final visible answer" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const outputJson = JSON.stringify(outputMessages);
    expect(outputJson).toContain("final visible answer");
    expect(outputJson).toContain("...(truncated)");
  });

  it("bounds text probing after the capture budget is exhausted", async () => {
    let outputMessages: unknown;
    const { diagnostics, stop } = createOutputDiagnostics((messages) => {
      outputMessages = messages;
    });

    diagnostics.emitStarted();
    diagnostics.observeAssistantMessage({
      content: Array.from({ length: 198 }, (_, index) => ({
        type: "thinking",
        thinking: `reason-${index}`,
      })),
    });
    diagnostics.observeAssistantMessage({
      content: [
        ...Array.from({ length: 10_000 }, () => ({ type: "thinking", thinking: "later" })),
        { type: "text", text: "outside-probe-window" },
      ],
    });
    diagnostics.emitCompleted({ text: "final visible answer" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const outputJson = JSON.stringify(outputMessages);
    expect(outputJson).toContain("final visible answer");
    expect(outputJson).not.toContain("outside-probe-window");
  });

  it("counts the truncation marker within the output item limit", async () => {
    let outputMessages: unknown;
    const { diagnostics, stop } = createOutputDiagnostics((messages) => {
      outputMessages = messages;
    });

    diagnostics.emitStarted();
    diagnostics.observeAssistantMessage({
      content: Array.from({ length: 201 }, (_, index) => ({
        type: "text",
        text: `part-${index}`,
      })),
    });
    diagnostics.emitCompleted({ text: "done" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const messages = outputMessages as Array<{ content?: unknown[] }>;
    const itemCount = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
    expect(itemCount).toBe(200);
    expect(JSON.stringify(messages)).toContain("...(truncated)");
  });

  describe("API steps", () => {
    function createStepHarness() {
      const events: DiagnosticEventPayload[] = [];
      onTrustedInternalDiagnosticEvent((event) => events.push(event));
      const runTrace = createDiagnosticTraceContext();
      let clock = 1_000;
      const diagnostics = expectDefined(
        runWithDiagnosticTraceContext(runTrace, () =>
          createClaudeCliModelCallDiagnostics({
            context: createContext(),
            prompt: "hello",
            transport: "stdio-live",
            now: () => clock,
          }),
        ),
        "Claude CLI diagnostics",
      );
      return {
        diagnostics,
        events,
        runTrace,
        at: (ms: number) => {
          clock = ms;
        },
      };
    }

    it("emits one request span per API step inside the turn span, with spawn kept out of step one", async () => {
      const { diagnostics, events, runTrace, at } = createStepHarness();
      // The prompt was prepared at 1000 (harness creation); the lane was taken at 1000.
      at(1_000);
      diagnostics.emitStarted();
      at(1_400);
      diagnostics.observeRequestSent();
      at(1_500);
      diagnostics.observeStep({
        kind: "message_start",
        messageId: "m1",
        usage: { input: 10, output: 1, cacheRead: 100, total: 111 },
      });
      at(1_700);
      diagnostics.observeStep({ kind: "content" });
      at(1_800);
      diagnostics.observeStep({ kind: "content" });
      diagnostics.observeStep({ kind: "message_delta", usage: { output: 20, total: 20 } });
      at(2_000);
      diagnostics.observeStep({ kind: "message_stop" });
      at(2_500);
      diagnostics.observeStep({ kind: "tool_result" });
      at(2_600);
      diagnostics.observeStep({ kind: "tool_result" });
      at(2_700);
      diagnostics.observeStep({
        kind: "message_start",
        messageId: "m2",
        usage: { input: 30, output: 1, cacheRead: 110, total: 141 },
      });
      at(2_800);
      diagnostics.observeStep({ kind: "content" });
      diagnostics.observeStep({ kind: "message_delta", usage: { output: 5, total: 5 } });
      at(3_000);
      diagnostics.observeStep({ kind: "message_stop" });
      at(3_100);
      diagnostics.emitCompleted({
        text: "done",
        diagnosticUsage: { input: 40, output: 25, cacheRead: 210, total: 275 },
      } as CliOutput);
      await waitForDiagnosticEventsDrained();

      const modelEvents = events.filter(
        (event) => event.type === "model.call.started" || event.type === "model.call.completed",
      );
      const turn = modelEvents.filter((event) => event.observationUnit === "turn");
      const steps = modelEvents.filter((event) => event.observationUnit === "request");
      expect(turn.map((event) => event.type)).toEqual([
        "model.call.started",
        "model.call.completed",
      ]);
      expect(steps.map((event) => event.type)).toEqual([
        "model.call.started",
        "model.call.completed",
        "model.call.started",
        "model.call.completed",
      ]);
      const turnSpan = expectDefined(turn[0]?.trace?.spanId, "turn span");
      expect(turn[0]?.trace?.parentSpanId).toBe(runTrace.spanId);
      for (const step of steps) {
        expect(step).toMatchObject({
          provider: "anthropic",
          model: "claude-test",
          api: "claude-code",
          transport: "stdio-live",
        });
        expect(step.trace?.parentSpanId).toBe(turnSpan);
        expect(step.trace?.traceId).toBe(runTrace.traceId);
        expect(step).not.toHaveProperty("promptStats");
      }
      const [start1, done1, start2, done2] = steps;
      // The started events carry when each request began, though they are sent when
      // its first stream record arrives (1500 and 2700).
      expect(start1).toMatchObject({ startedAt: 1_400 });
      expect(start2).toMatchObject({ startedAt: 2_600 });
      expect(start1?.trace?.spanId).toBe(done1?.trace?.spanId);
      expect(start2?.trace?.spanId).toBe(done2?.trace?.spanId);
      expect(start1?.trace?.spanId).not.toBe(start2?.trace?.spanId);
      expect(new Set([start1?.callId, start2?.callId, turn[0]?.callId]).size).toBe(3);
      // Step one starts when the request was accepted (1400), not at spawn (1000);
      // the first token came at 1700 and the message ended at 2000.
      expect(done1).toMatchObject({
        durationMs: 600,
        timeToFirstByteMs: 300,
        usage: { input: 10, output: 20, cacheRead: 100, total: 130 },
      });
      // Step two starts at the last tool result (2600), not at its message_start.
      expect(done2).toMatchObject({
        durationMs: 400,
        timeToFirstByteMs: 200,
        usage: { input: 30, output: 5, cacheRead: 110, total: 145 },
      });
      const sum = (key: "input" | "output" | "cacheRead" | "total") =>
        (done1?.usage?.[key] ?? 0) + (done2?.usage?.[key] ?? 0);
      expect(turn[1]?.usage).toEqual({ input: 40, output: 25, cacheRead: 210, total: 275 });
      expect(sum("input")).toBe(40);
      expect(sum("output")).toBe(25);
      expect(sum("cacheRead")).toBe(210);
      expect(sum("total")).toBe(275);
      expect(turn[1]).toMatchObject({ durationMs: 2_100 });

      const stages = events.filter((event) => event.type === "context.stages");
      expect(stages).toHaveLength(1);
      expect(stages[0]).toMatchObject({
        runId: "claude-diagnostics-test",
        stages: [{ name: CLI_PROCESS_START_STAGE, startedAt: 1_000, endedAt: 1_400 }],
      });
      expect(stages[0]?.trace?.parentSpanId).toBe(runTrace.spanId);
    });

    it("reports the wait for the CLI lane before the process start", async () => {
      const { diagnostics, events, at } = createStepHarness();
      at(1_250);
      diagnostics.emitStarted();
      at(1_600);
      diagnostics.observeRequestSent();
      diagnostics.emitCompleted({ text: "x" } as CliOutput);
      await waitForDiagnosticEventsDrained();
      const stages = events.filter((event) => event.type === "context.stages");
      expect(stages).toHaveLength(1);
      expect(stages[0]).toMatchObject({
        stages: [
          { name: CLI_LANE_QUEUE_STAGE, startedAt: 1_000, endedAt: 1_250 },
          { name: CLI_PROCESS_START_STAGE, startedAt: 1_250, endedAt: 1_600 },
        ],
      });
    });

    it("keeps a full cache miss's counts when the delta repeats them or reports only output", async () => {
      const { diagnostics, events, at } = createStepHarness();
      at(1_000);
      diagnostics.emitStarted();
      diagnostics.observeRequestSent();
      const cold = { input: 2, cacheRead: 0, cacheWrite: 158_721, output: 1 };
      diagnostics.observeStep({ kind: "message_start", messageId: "m1", usage: cold });
      diagnostics.observeStep({ kind: "message_delta", usage: { ...cold, output: 40 } });
      diagnostics.observeStep({ kind: "message_stop" });
      diagnostics.observeStep({ kind: "tool_result" });
      diagnostics.observeStep({ kind: "message_start", messageId: "m2", usage: cold });
      diagnostics.observeStep({ kind: "message_delta", usage: { output: 7 } });
      diagnostics.observeStep({ kind: "message_stop" });
      diagnostics.emitCompleted({ text: "x" } as CliOutput);
      await waitForDiagnosticEventsDrained();
      const done = events.filter(
        (event) => event.type === "model.call.completed" && event.observationUnit === "request",
      );
      expect(done.map((event) => event.usage)).toEqual([
        { input: 2, output: 40, cacheRead: 0, cacheWrite: 158_721, total: 158_763 },
        { input: 2, output: 7, cacheRead: 0, cacheWrite: 158_721, total: 158_730 },
      ]);
    });

    it("starts the first step at its message when no request-sent mark arrived", async () => {
      const { diagnostics, events, at } = createStepHarness();
      diagnostics.emitStarted();
      at(1_900);
      diagnostics.observeStep({ kind: "message_start", messageId: "m1" });
      at(2_000);
      diagnostics.observeStep({ kind: "message_stop" });
      // A late mark cannot move a step that already began.
      diagnostics.observeRequestSent();
      diagnostics.emitCompleted({ text: "x" } as CliOutput);
      await waitForDiagnosticEventsDrained();
      expect(events.filter((event) => event.type === "context.stages")).toEqual([]);
      expect(
        events.find(
          (event) => event.type === "model.call.completed" && event.observationUnit === "request",
        ),
      ).toMatchObject({ durationMs: 100 });
    });

    it("ends an open step as an error when the turn fails, and as completed when it succeeds", async () => {
      const failed = createStepHarness();
      failed.diagnostics.emitStarted();
      failed.at(1_100);
      failed.diagnostics.observeStep({ kind: "message_start", messageId: "m1" });
      failed.at(1_300);
      failed.diagnostics.emitError(new Error("boom"));
      failed.diagnostics.emitError(new Error("again"));
      await waitForDiagnosticEventsDrained();
      const failedTypes = failed.events
        .filter((event) => event.type.startsWith("model.call."))
        .map((event) => `${event.observationUnit}:${event.type}`);
      expect(failedTypes).toEqual([
        "turn:model.call.started",
        "request:model.call.started",
        "request:model.call.error",
        "turn:model.call.error",
      ]);

      resetDiagnosticEventsForTest();
      const completed = createStepHarness();
      completed.diagnostics.emitStarted();
      completed.diagnostics.observeStep({ kind: "message_start" });
      completed.diagnostics.emitCompleted({ text: "x" } as CliOutput);
      completed.diagnostics.observeStep({ kind: "message_start" });
      await waitForDiagnosticEventsDrained();
      expect(
        completed.events
          .filter((event) => event.type.startsWith("model.call."))
          .map((event) => `${event.observationUnit}:${event.type}`),
      ).toEqual([
        "turn:model.call.started",
        "request:model.call.started",
        "request:model.call.completed",
        "turn:model.call.completed",
      ]);
    });

    it("parents a tool call on the open step, else the run", () => {
      const { diagnostics, runTrace } = createStepHarness();
      diagnostics.emitStarted();
      expect(diagnostics.currentParentTrace()?.spanId).toBe(runTrace.spanId);
      diagnostics.observeStep({ kind: "message_start" });
      const stepSpan = diagnostics.currentParentTrace()?.spanId;
      expect(stepSpan).not.toBe(runTrace.spanId);
      diagnostics.observeStep({ kind: "message_stop" });
      expect(diagnostics.currentParentTrace()?.spanId).toBe(runTrace.spanId);
    });
  });
});
