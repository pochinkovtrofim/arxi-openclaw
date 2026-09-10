// Codex tests cover diagnostic trace propagation into native app-server requests.
import path from "node:path";
import { runWithDiagnosticTraceContext } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  createAppServerHarness,
  createCodexRuntimePlanFixture,
  createParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

const diagnosticTrace = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: "01",
};

function readRequestOptions(
  request: ReturnType<typeof createAppServerHarness>["request"],
  method: string,
): { trace?: { traceparent?: string } } | undefined {
  return request.mock.calls.find(([candidate]) => candidate === method)?.[2] as
    | { trace?: { traceparent?: string } }
    | undefined;
}

describe("Codex app-server diagnostic trace context", () => {
  it.each([
    { enabled: true, label: "propagates" },
    { enabled: false, label: "omits" },
  ])("$label trace context when diagnostics enabled=$enabled", async ({ enabled }) => {
    const harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "completed");
      }
      return {};
    });
    const params = createParams(
      path.join(tempDir, `trace-${enabled}.jsonl`),
      path.join(tempDir, `workspace-trace-${enabled}`),
    );
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.diagnosticTrace = diagnosticTrace;
    params.config = { diagnostics: { enabled } } as never;

    const run = runWithDiagnosticTraceContext(diagnosticTrace, () =>
      runCodexAppServerAttempt(params, { turnCompletionIdleTimeoutMs: 5 }),
    );
    await harness.waitForMethod("turn/start");
    await run;

    const threadStart = readRequestOptions(harness.request, "thread/start");
    const turnStart = readRequestOptions(harness.request, "turn/start");
    if (!enabled) {
      expect(threadStart).not.toHaveProperty("trace");
      expect(turnStart).not.toHaveProperty("trace");
      return;
    }
    expect(threadStart?.trace?.traceparent).toBe(
      "00-11111111111111111111111111111111-2222222222222222-01",
    );
    expect(turnStart?.trace?.traceparent).toMatch(
      /^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/u,
    );
  });
});
