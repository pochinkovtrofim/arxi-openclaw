import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { beginForegroundSessionMaintenance, waitForSessionMaintenance } from "./coordinator.js";
import { scheduleColdCacheAheadMaintenance } from "./run.js";

const memory = vi.hoisted(() => ({
  runMemoryFlushIfNeeded: vi.fn(async () => ({ outcome: "skipped" })),
  runSessionCompactionIfNeeded: vi.fn(async (_params: { abortSignal?: AbortSignal }) => {}),
}));
// mock-isolation: Admission uses real stores and workers; model and persistence effects stay inert.
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: async () => memory,
  loadSessionStoreRuntime: () => import("../command/session-store.runtime.js"),
}));

const MINUTE = 60_000;
const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      models: { "anthropic/claude-opus-5-5": { params: { cacheRetention: "long" } } },
    },
  },
};

afterEach(() => {
  vi.useRealTimers();
  memory.runMemoryFlushIfNeeded.mockClear();
  memory.runSessionCompactionIfNeeded.mockReset();
});

async function withIdleSession(
  run: (session: {
    sessionKey: string;
    armAfterTurn: (completed: boolean) => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cold-cache-ahead" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:cold-cache-ahead";
    const entry = { sessionId: "cold-cache-ahead", lifecycleRevision: "initial", updatedAt: 1 };
    writeSessionEntry(database, sessionKey, entry);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const armAfterTurn = async (completed: boolean) => {
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
        () =>
          scheduleColdCacheAheadMaintenance(
            {
              // No deadline timer, so fake time can pass without expiring the run.
              prepared: {
                cfg,
                sessionKey,
                storePath: database.path,
                timeoutMs: MAX_TIMER_TIMEOUT_MS,
              },
              followupRun: createTestFollowupRun({
                sessionKey,
                sessionId: entry.sessionId,
                provider: "anthropic",
                model: "claude-opus-5-5",
              }),
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              startedAt: Date.now(),
            },
            Promise.resolve(completed),
          ),
      );
      // Let the turn's settlement arm the timer.
      await vi.advanceTimersByTimeAsync(0);
    };
    try {
      await run({ sessionKey, armAfterTurn });
    } finally {
      vi.useRealTimers();
      await waitForSessionMaintenance(sessionKey);
    }
  });
}

it("runs the cold-cache step once, ten minutes before the cache of the latest turn expires", async () => {
  await withIdleSession(async ({ sessionKey, armAfterTurn }) => {
    await armAfterTurn(true);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    // A later turn replaces the first timer, so the session is not compacted at 50 minutes.
    await armAfterTurn(true);
    await vi.advanceTimersByTimeAsync(49 * MINUTE);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MINUTE);
    await waitForSessionMaintenance(sessionKey);
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ coldCacheAhead: true, beforeCompaction: expect.any(Function) }),
    );
    // Memory is flushed only as the compaction's checkpoint, as on the reply path.
    expect(memory.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
  });
});

it("arms nothing after a turn that did not complete", async () => {
  await withIdleSession(async ({ sessionKey, armAfterTurn }) => {
    await armAfterTurn(false);
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();
  });
});

it("yields to a turn that arrives during the early compaction", async () => {
  const started = createDeferred();
  memory.runSessionCompactionIfNeeded.mockImplementationOnce(async ({ abortSignal }) => {
    started.resolve();
    await new Promise((_, reject) => {
      abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    });
  });
  await withIdleSession(async ({ sessionKey, armAfterTurn }) => {
    await armAfterTurn(true);
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    vi.useRealTimers();
    await started.promise;
    const [{ abortSignal }] = memory.runSessionCompactionIfNeeded.mock.calls[0] ?? [{}];
    expect(abortSignal?.aborted).toBe(false);

    // A visible reply turn reserves foreground priority at admission (admitReplyTurn).
    const release = await beginForegroundSessionMaintenance(sessionKey);
    try {
      expect(abortSignal?.aborted).toBe(true);
      expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });
});
