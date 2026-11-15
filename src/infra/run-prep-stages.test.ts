import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createStageTimingTracker } from "../shared/stage-timing.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import { createRunPrepStageReporter, measurePrepStage, withPrepStages } from "./run-prep-stages.js";

const emitted = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("./diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diagnostic-events.js")>()),
  emitTrustedDiagnosticEvent: (event: unknown) => emitted.events.push(event),
}));

const root = path.resolve(import.meta.dirname, "../..");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, dir))) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const relative = path.join(dir, entry);
    if (statSync(path.join(root, relative)).isDirectory()) {
      files.push(...sourceFiles(relative));
    } else if (/\.tsx?$/u.test(entry) && !/\.test(\.|-)|test-(support|helpers)/u.test(entry)) {
      files.push(relative);
    }
  }
  return files;
}

describe("run preparation stage reporter", () => {
  it("names the last checkpoint and reports once", () => {
    emitted.events.length = 0;
    let clock = 100;
    const tracker = createStageTimingTracker(() => clock);
    clock = 130;
    tracker.mark("setup");
    clock = 150;
    const report = createRunPrepStageReporter({
      tracker,
      runId: "run-1",
      runTrace: createDiagnosticTraceContext(),
      finalStage: "native-turn-handoff",
      now: () => clock,
    });
    report();
    report();
    expect(emitted.events).toHaveLength(1);
    expect(emitted.events[0]).toMatchObject({
      type: "context.stages",
      stages: [
        { name: "setup", startedAt: 100, endedAt: 130 },
        { name: "native-turn-handoff", startedAt: 130, endedAt: 150 },
      ],
    });
  });

  // The exporter binds stage spans only beneath a span it tracks. The command's
  // attempt trace is never tracked, so stages parented there were dropped
  // (Codex owner turns showed no preparation at all).
  it("parents the stages on the run span active at creation", () => {
    emitted.events.length = 0;
    const commandTrace = createDiagnosticTraceContext();
    const runTrace = createChildDiagnosticTraceContext(commandTrace);
    const report = runWithDiagnosticTraceContext(runTrace, () =>
      createRunPrepStageReporter({ tracker: createStageTimingTracker(), runId: "run-1" }),
    );
    runWithDiagnosticTraceContext(commandTrace, report);
    expect(emitted.events[0]).toMatchObject({
      trace: { traceId: runTrace.traceId, parentSpanId: runTrace.spanId },
    });
  });
});

// Every runtime that emits a model call must report its preparation stages
// through the one shared reporter. A runner that reaches its first model
// request without reporting them leaves the work trace blind to the time
// before the model, so adding an emitter without a reporter fails here.
describe("model call emitters report preparation stages", () => {
  const runners: Array<{ emitter: string; reporterUsers: string[] }> = [
    {
      emitter: "src/infra/diagnostic-model-request.ts",
      reporterUsers: ["src/agents/embedded-agent-runner/run/attempt-prompt-phase.ts"],
    },
    {
      emitter: "src/agents/cli-runner/model-call-diagnostics.ts",
      reporterUsers: ["src/agents/cli-runner/prep-stages.ts"],
    },
    {
      emitter: "extensions/codex/src/app-server/attempt-diagnostics.ts",
      reporterUsers: ["extensions/codex/src/app-server/attempt-preparation-timing.ts"],
    },
  ];

  it("knows every source that emits model.call.started", () => {
    const emitters = [...sourceFiles("src"), ...sourceFiles("extensions")]
      .filter((file) => !file.startsWith("extensions/diagnostics-otel/"))
      .filter((file) =>
        /type:\s*"model\.call\.started"(?:\s+as const)?,/u.test(
          readFileSync(path.join(root, file), "utf8"),
        ),
      )
      .toSorted();
    expect(emitters).toEqual(runners.map((runner) => runner.emitter).toSorted());
  });

  it.each(runners)(
    "reports stages through the shared reporter for $emitter",
    ({ reporterUsers }) => {
      for (const file of reporterUsers) {
        expect(readFileSync(path.join(root, file), "utf8")).toMatch(
          /createRunPrepStageReporter\(/u,
        );
      }
    },
  );
});

describe("measured preparation steps", () => {
  it("times a step inside the preparation that put its tracker in scope", async () => {
    let clock = 0;
    const tracker = createStageTimingTracker(() => clock);
    await withPrepStages(tracker, async () => {
      clock = 10;
      tracker.mark("mcp-run-admission");
      await measurePrepStage("mcp-requester-resolve", async () => {
        clock = 480;
      });
      tracker.mark("mcp-tool-projection");
    });
    expect(tracker.snapshot().stages).toEqual([
      { name: "mcp-run-admission", durationMs: 10, elapsedMs: 10 },
      { name: "mcp-requester-resolve", durationMs: 470, elapsedMs: 480 },
      { name: "mcp-tool-projection", durationMs: 470, elapsedMs: 480 },
    ]);
  });

  it("names every measured step in a form the host keeps", () => {
    const names = sourceFiles("src").flatMap((file) =>
      [...readFileSync(path.join(root, file), "utf8").matchAll(/measurePrepStage\(\s*"([^"]*)"/gu)].map(
        (match) => match[1],
      ),
    );
    expect(names.length).toBeGreaterThanOrEqual(7);
    expect(names.filter((name) => !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(name ?? ""))).toEqual([]);
  });

  it("only runs a step outside any preparation", async () => {
    const tracker = createStageTimingTracker(() => 0);
    await withPrepStages(tracker, async () => {});
    await expect(measurePrepStage("mcp-requester-resolve", async () => 7)).resolves.toBe(7);
    expect(tracker.snapshot().stages).toEqual([]);
  });
});
