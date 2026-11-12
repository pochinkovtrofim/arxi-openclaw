import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { beginForegroundSessionMaintenance, waitForSessionMaintenance } from "./coordinator.js";
import { scheduleColdCacheAheadMaintenance } from "./run.js";

const memory = vi.hoisted(() => ({
  runMemoryFlushIfNeeded: vi.fn(async () => ({ outcome: "skipped" })),
  runSessionCompactionIfNeeded: vi.fn(
    async (_params: {
      abortSignal?: AbortSignal;
      onColdCacheNotDue?: (delayMs: number) => void;
    }) => {},
  ),
}));
// mock-isolation: Admission uses real stores and workers; model and persistence effects stay inert.
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: async () => memory,
  loadSessionStoreRuntime: () => import("../command/session-store.runtime.js"),
}));

const MINUTE = 60_000;
// The early run starts three minutes before the 1 h prompt cache expires.
const AHEAD_MS = 57 * MINUTE;
const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-5-5" },
      models: { "anthropic/claude-opus-5-5": { params: { cacheRetention: "long" } } },
    },
  },
};
const largeSession = {
  totalTokens: 180_000,
  totalTokensFresh: true,
  totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
};

function pendingColdCacheAheadTimers(): number | undefined {
  const timers = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.coldCacheAheadMaintenance")
  ];
  return timers instanceof Map ? timers.size : undefined;
}

beforeEach(() => {
  // The timer looks up the Gateway's registry when it fires, not the finished request's.
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.useRealTimers();
  memory.runMemoryFlushIfNeeded.mockClear();
  memory.runSessionCompactionIfNeeded.mockReset();
});

async function withIdleSession(
  run: (session: {
    sessionKey: string;
    arm: (afterTurn: Promise<boolean>, turnEntry?: Partial<SessionEntry>) => Promise<void>;
  }) => Promise<void>,
  storedEntry: Partial<SessionEntry> = {},
) {
  await withOpenClawTestState({ label: "cold-cache-ahead" }, async (state) => {
    await state.writeConfig(cfg);
    // The Gateway publishes its runtime config before any turn; the timer reads it.
    await captureRuntimeConfigAsyncReader()();
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const sessionKey = "agent:main:cold-cache-ahead";
    const entry = {
      sessionId: "cold-cache-ahead",
      lifecycleRevision: "initial",
      updatedAt: 1,
      ...largeSession,
    };
    writeSessionEntry(database, sessionKey, { ...entry, ...storedEntry });
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const arm = async (afterTurn: Promise<boolean>, turnEntry: Partial<SessionEntry> = {}) => {
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
            { ...entry, ...turnEntry },
            afterTurn,
          ),
      );
      // Let a settled turn arm the timer.
      await vi.advanceTimersByTimeAsync(0);
    };
    try {
      await run({ sessionKey, arm });
    } finally {
      vi.useRealTimers();
      await waitForSessionMaintenance(sessionKey);
    }
  });
}

it("runs the cold-cache step once, three minutes before the cache of the latest turn expires", async () => {
  await withIdleSession(async ({ sessionKey, arm }) => {
    await arm(Promise.resolve(true));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    // A later turn replaces the first timer, so the session is not compacted at 57 minutes.
    await arm(Promise.resolve(true));
    await vi.advanceTimersByTimeAsync(AHEAD_MS - MINUTE);
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

it("counts from the end of after-turn maintenance, the session's last model activity", async () => {
  await withIdleSession(async ({ sessionKey, arm }) => {
    const afterTurn = createDeferred<boolean>();
    await arm(afterTurn.promise);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    afterTurn.resolve(true);
    await vi.advanceTimersByTimeAsync(AHEAD_MS - MINUTE);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
  });
});

it("follows later activity in the session and still runs before the cache expires", async () => {
  memory.runSessionCompactionIfNeeded.mockImplementationOnce(async ({ onColdCacheNotDue }) => {
    // A background run in the owner's chat used the model 10 minutes after the turn.
    onColdCacheNotDue?.(10 * MINUTE);
  });
  await withIdleSession(async ({ sessionKey, arm }) => {
    await arm(Promise.resolve(true));
    await vi.advanceTimersByTimeAsync(AHEAD_MS);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledTimes(2);
  });
});

it("stops following activity after three moves when nobody returns", async () => {
  memory.runSessionCompactionIfNeeded.mockImplementation(async ({ onColdCacheNotDue }) => {
    onColdCacheNotDue?.(30 * MINUTE);
  });
  await withIdleSession(async ({ sessionKey, arm }) => {
    await arm(Promise.resolve(true));
    // Fake time stops at each fire: a worker read must not see hours pass mid-flight.
    for (const delayMs of [AHEAD_MS, 30 * MINUTE, 30 * MINUTE, 30 * MINUTE]) {
      await vi.advanceTimersByTimeAsync(delayMs);
      await waitForSessionMaintenance(sessionKey);
    }
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledTimes(4);
    // No early-run timer is left; the pooled SQLite readers keep their own idle timers.
    expect(pendingColdCacheAheadTimers()).toBe(0);
    await vi.advanceTimersByTimeAsync(12 * 60 * MINUTE);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledTimes(4);
  });
});

it("still runs when the finished turn's work scope has closed", async () => {
  await withIdleSession(async ({ sessionKey, arm }) => {
    const request = new AsyncWorkScope();
    await request.run(() => arm(Promise.resolve(true)));
    await request.drain();
    await vi.advanceTimersByTimeAsync(AHEAD_MS);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
  });
});

it.each([
  ["a turn that did not complete", Promise.resolve(false), {}],
  ["a session below the cold-cache threshold", Promise.resolve(true), { totalTokens: 90_000 }],
] as const)("arms nothing after %s", async (_case, afterTurn, turnEntry) => {
  await withIdleSession(async ({ sessionKey, arm }) => {
    await arm(afterTurn, turnEntry);
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    await waitForSessionMaintenance(sessionKey);
    expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();
  });
});

it("skips the early run once the session's model selection changed", async () => {
  await withIdleSession(
    async ({ sessionKey, arm }) => {
      await arm(Promise.resolve(true));
      await vi.advanceTimersByTimeAsync(AHEAD_MS);
      await waitForSessionMaintenance(sessionKey);
      expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();
    },
    { providerOverride: "anthropic", modelOverride: "claude-sonnet-5-5" },
  );
});

it("yields to a turn that arrives during the early compaction", async () => {
  const started = createDeferred();
  memory.runSessionCompactionIfNeeded.mockImplementationOnce(async ({ abortSignal }) => {
    started.resolve();
    await new Promise((_, reject) => {
      abortSignal?.addEventListener(
        "abort",
        () =>
          reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("aborted")),
        { once: true },
      );
    });
  });
  await withIdleSession(async ({ sessionKey, arm }) => {
    await arm(Promise.resolve(true));
    await vi.advanceTimersByTimeAsync(AHEAD_MS);
    vi.useRealTimers();
    await started.promise;
    const [{ abortSignal }] = memory.runSessionCompactionIfNeeded.mock.calls[0] ?? [{}];
    expect(abortSignal?.aborted).toBe(false);

    // A visible turn reserves foreground priority at admission (admitReplyTurn, agentCommand).
    const release = await beginForegroundSessionMaintenance(sessionKey);
    try {
      expect(abortSignal?.aborted).toBe(true);
      expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });
});
