import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";

// Real decision, store, transcript reader and compaction accounting; only the summarizing
// compaction is replaced by its transcript effect (a compaction record, tokensAfter unknown).
const compact = vi.hoisted(() => vi.fn());
vi.mock("../../agents/embedded-agent.js", () => ({ compactEmbeddedAgentSession: compact }));

const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
  compact.mockReset();
});

it("compacts once early and leaves the owner's later turn uncompacted", async () => {
  const state = await createOpenClawTestState({ prefix: "openclaw-cold-cache-ahead-" });
  try {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
    const target = {
      agentId: "main",
      sessionId: "cold-cache-ahead",
      sessionKey: "agent:main:cold-cache-ahead",
      storePath: state.path("sessions.sqlite"),
    };
    await replaceSessionEntry(target, {
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      totalTokens: 180_000,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
    const manager = SessionManager.open(target, state.workspaceDir);
    const first = manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage: {
        input: 180_000,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 180_500,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    compact.mockImplementation(async () => {
      SessionManager.open(target, state.workspaceDir).appendCompaction("summary", first, 180_000);
      return { ok: true, compacted: true, result: {} };
    });
    const followupRun = createTestFollowupRun({
      provider: "anthropic",
      model: "claude-opus-5-5",
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      workspaceDir: state.workspaceDir,
    });
    const cfg = withTestModelContextTokens({
      cfg: {
        agents: {
          defaults: {
            models: { "anthropic/claude-opus-5-5": { params: { cacheRetention: "long" } } },
          },
        },
      } satisfies OpenClawConfig,
      followupRun,
      defaultModel: "anthropic/claude-opus-5-5",
      contextTokens: 1_000_000,
    });
    const check = async (coldCacheAhead: boolean) =>
      await runSessionCompactionIfNeeded({
        cfg,
        followupRun,
        promptForEstimate: "",
        defaultModel: "anthropic/claude-opus-5-5",
        sessionEntry: loadSessionEntry(target),
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        isHeartbeat: false,
        coldCacheAhead,
      });

    vi.setSystemTime(Date.now() + 58 * MINUTE);
    await check(true);
    expect(compact).toHaveBeenCalledOnce();
    // tokensAfter was unknown, so the stored total is no longer trusted.
    expect(loadSessionEntry(target)).toMatchObject({ compactionCount: 1, totalTokensFresh: false });

    vi.setSystemTime(Date.now() + 7 * MINUTE);
    await check(false);
    expect(compact).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    await state.cleanup();
  }
});
