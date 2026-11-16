import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPrepStages } from "../infra/run-prep-stages.js";
import { createStageTimingTracker } from "../shared/stage-timing.js";
import { hookTimingLabel, promptHookStageName, takeHookPhaseTimings } from "./hook-phase-timing.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";

const RUN_ID = "run-phase-timing";
const ctx = { ...TEST_PLUGIN_AGENT_CTX, runId: RUN_ID };
const promptEvent = { prompt: "hello", messages: [] };

describe("gating hook phase timing", () => {
  afterEach(() => {
    vi.useRealTimers();
    takeHookPhaseTimings(RUN_ID);
  });

  it("reports the slowest prompt hook and a timed-out handler without changing the result", async () => {
    // The handlers run together: the phase lasts as long as the slowest one.
    vi.useFakeTimers();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          pluginId: "arxi-channel",
          registrationId: "relationship-state",
          priority: 10,
          timeoutMs: 2_000,
          handler: () => new Promise(() => {}),
        },
        {
          hookName: "before_prompt_build",
          pluginId: "memory",
          priority: 1,
          handler: async () => {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 300);
            });
            return { appendContext: "recalled" };
          },
        },
      ]),
      { catchErrors: true },
    );

    const pending = runner.runBeforePromptBuild(promptEvent, ctx);
    await vi.advanceTimersByTimeAsync(2_300);
    await expect(pending).resolves.toMatchObject({ appendContext: "recalled" });

    const { before_prompt_build: timing } = takeHookPhaseTimings(RUN_ID);
    expect(timing).toEqual({
      durationMs: 2_000,
      count: 2,
      timeouts: 1,
      slowest: "arxi-channel:relationship-state",
      slowestMs: 2_000,
    });
    // Taking clears the run so a later prompt build reports only its own hooks.
    expect(takeHookPhaseTimings(RUN_ID)).toEqual({});
  });

  it("times before_agent_run separately and ignores runs without a run id", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", pluginId: "gate", handler: () => undefined },
        { hookName: "before_prompt_build", pluginId: "prompt", handler: () => undefined },
      ]),
    );
    await runner.runBeforeAgentRun({ prompt: "hello", messages: [] } as never, ctx);
    await runner.runBeforePromptBuild(promptEvent, { ...ctx, runId: undefined });

    const timings = takeHookPhaseTimings(RUN_ID);
    expect(timings.before_agent_run).toMatchObject({ count: 1, timeouts: 0, slowest: "gate#0" });
    expect(timings.before_prompt_build).toBeUndefined();
  });

  it("times each prompt hook as a measured step of the run's preparation", async () => {
    let clock = 0;
    const tracker = createStageTimingTracker(() => clock);
    const connections = createDeferred();
    const memory = createDeferred();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          pluginId: "arxi-channel",
          registrationId: "connections",
          priority: 10,
          handler: async () => {
            await connections.promise;
            return { appendContext: "setup" };
          },
        },
        {
          hookName: "before_prompt_build",
          pluginId: "memory",
          priority: 1,
          handler: async () => {
            await memory.promise;
            return undefined;
          },
        },
      ]),
    );
    const run = withPrepStages(tracker, () => runner.runBeforePromptBuild(promptEvent, ctx));
    clock = 5;
    memory.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    clock = 40;
    connections.resolve();
    await run;

    // Both stages start with the dispatch and overlap; each ends when its handler settles.
    expect(tracker.snapshot().stages.map(({ name, durationMs }) => [name, durationMs])).toEqual([
      ["hook-memory-1", 5],
      ["hook-arxi-channel-connections", 40],
    ]);
  });

  it("names a prompt hook's stage in the host's stage alphabet", () => {
    for (const label of ["arxi-channel:group-rules", "plugin#99", "A:B.C_d"]) {
      expect(promptHookStageName(label)).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/u);
    }
    expect(promptHookStageName(`${"p".repeat(47)}:connections`)).toMatch(/^hook-p+-connections$/u);
    expect(promptHookStageName(`${"p".repeat(47)}:connections`).length).toBeLessThanOrEqual(48);
  });

  it("keeps labels to plugin and registration code identifiers", () => {
    expect(hookTimingLabel({ pluginId: "arxi-channel", registrationId: "group-rules" }, 3)).toBe(
      "arxi-channel:group-rules",
    );
    expect(hookTimingLabel({ pluginId: "arxi-channel", registrationId: "has space" }, 3)).toBe(
      "arxi-channel#3",
    );
    expect(hookTimingLabel({ pluginId: "../x" }, 250)).toBe("plugin#99");
  });
});
