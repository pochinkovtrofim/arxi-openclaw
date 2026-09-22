import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { createCronScriptRuntimeFixture } from "./trigger-script.test-helpers.js";

function preparedRuntime(config: OpenClawConfig) {
  const tool = wrapToolWithBeforeToolCallHook(
    {
      name: "probe",
      label: "Probe",
      description: "Probe",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    } satisfies AnyAgentTool,
    { config, agentId: "main", sessionKey: "agent:main:cron:condition" },
  );
  return {
    createTools: () => [tool],
    context: {
      config,
      agentId: "main",
      sessionKey: "agent:main:cron:condition",
    },
  };
}

function completed(value: unknown): CodeModeHeadlessResult {
  return { status: "completed", value, output: [], toolCallCount: 0 };
}

function captureRunEvents() {
  const events: Array<
    Extract<DiagnosticEventPayload, { type: "headless.run.started" | "headless.run.completed" }>
  > = [];
  const stop = onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
    if (event.type === "headless.run.started" || event.type === "headless.run.completed") {
      expect(metadata.trusted).toBe(true);
      expect(privateData ?? {}).toEqual({});
      events.push(event);
    }
  });
  return { events, stop };
}

beforeEach(() => resetDiagnosticEventsForTest());
afterEach(() => {
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

describe("headless Cron condition diagnostic lifecycle", () => {
  it("closes a successful condition that does not fire", async () => {
    const config: OpenClawConfig = {};
    const runtime = createCronScriptRuntimeFixture({
      config,
      prepareRuntime: async () => preparedRuntime(config),
      runHeadless: async () => completed({ fire: false }),
    });
    const captured = captureRunEvents();
    try {
      await expect(
        runtime.evaluateTrigger({
          jobId: "no-fire",
          script: "return { fire: false }",
          state: null,
        }),
      ).resolves.toMatchObject({ kind: "evaluated", fire: false });
      await waitForDiagnosticEventsDrained();
    } finally {
      captured.stop();
    }
    expect(captured.events).toEqual([
      expect.objectContaining({
        type: "headless.run.started",
        runId: expect.stringMatching(/^cron-trigger:no-fire:/),
      }),
      expect.objectContaining({
        type: "headless.run.completed",
        runId: expect.stringMatching(/^cron-trigger:no-fire:/),
        outcome: "not_fired",
      }),
    ]);
    expect(captured.events[0]?.runId).toBe(captured.events[1]?.runId);
    expect(captured.events[0]?.trace).toEqual(captured.events[1]?.trace);
  });

  it("closes a failed condition without exposing its error text", async () => {
    const config: OpenClawConfig = {};
    const runtime = createCronScriptRuntimeFixture({
      config,
      prepareRuntime: async () => preparedRuntime(config),
      runHeadless: async () => ({
        status: "failed",
        code: "internal_error",
        error: "private fixture detail",
        output: [],
        toolCallCount: 0,
      }),
    });
    const captured = captureRunEvents();
    try {
      await expect(
        runtime.evaluateTrigger({ jobId: "failed", script: "throw new Error()", state: null }),
      ).resolves.toMatchObject({ kind: "error", code: "internal_error" });
      await waitForDiagnosticEventsDrained();
    } finally {
      captured.stop();
    }
    expect(captured.events.at(-1)).toMatchObject({
      type: "headless.run.completed",
      outcome: "error",
      errorCategory: "internal_error",
    });
    expect(JSON.stringify(captured.events)).not.toContain("private fixture detail");
  });

  it("closes only the condition run when it fires", async () => {
    const config: OpenClawConfig = {};
    const runtime = createCronScriptRuntimeFixture({
      config,
      prepareRuntime: async () => preparedRuntime(config),
      runHeadless: async () => completed({ fire: true }),
    });
    const captured = captureRunEvents();
    try {
      await expect(
        runtime.evaluateTrigger({ jobId: "fires", script: "return { fire: true }", state: null }),
      ).resolves.toMatchObject({ kind: "evaluated", fire: true });
      await waitForDiagnosticEventsDrained();
    } finally {
      captured.stop();
    }
    const started = captured.events.filter((event) => event.type === "headless.run.started");
    const completedEvents = captured.events.filter(
      (event) => event.type === "headless.run.completed",
    );
    expect(started).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);
    expect(started[0]?.runId).toBe(completedEvents[0]?.runId);
    expect(started[0]?.runId).toMatch(/^cron-trigger:fires:/);
    expect(completedEvents[0]).toMatchObject({ outcome: "fired" });
  });

  it("starts a fresh condition trace instead of inheriting the caller trace", async () => {
    const config: OpenClawConfig = {};
    const runtime = createCronScriptRuntimeFixture({
      config,
      prepareRuntime: async () => preparedRuntime(config),
      runHeadless: async () => completed({ fire: false }),
    });
    const captured = captureRunEvents();
    const callerTrace = createDiagnosticTraceContext();
    try {
      await runWithDiagnosticTraceContext(callerTrace, () =>
        runtime.evaluateTrigger({
          jobId: "fresh-root",
          script: "return { fire: false }",
          state: null,
        }),
      );
      await waitForDiagnosticEventsDrained();
    } finally {
      captured.stop();
    }
    expect(captured.events[0]?.trace?.traceId).not.toBe(callerTrace.traceId);
    expect(captured.events[0]?.trace).toEqual(captured.events[1]?.trace);
  });
});
