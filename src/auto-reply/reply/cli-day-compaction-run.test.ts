import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rememberCliDaySummaryReplay,
  resetCliDaySummaryReplaysForTest,
} from "../../agents/cli-runner/day-summary-replay.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  runCliAgent: vi.fn(),
  recordCliCompactionInStore: vi.fn(),
  manager: undefined as SessionManager | undefined,
}));

vi.mock("../../agents/cli-runner.runtime.js", () => ({ runCliAgent: mocks.runCliAgent }));
vi.mock("../../agents/command/session-store.js", () => ({
  recordCliCompactionInStore: mocks.recordCliCompactionInStore,
}));

const { runCliDayCompactionIfDue } = await import("./cli-day-compaction-run.js");

const cfg = { agents: { defaults: { userTimezone: "Europe/Madrid" } } } as OpenClawConfig;
const sessionKey = "agent:main:telegram:direct:1";

function say(manager: SessionManager, iso: string, role: "user" | "assistant", text: string) {
  vi.setSystemTime(new Date(iso));
  return manager.appendMessage(
    role === "user"
      ? { role, content: text, timestamp: Date.parse(iso) }
      : ({
          role,
          content: [{ type: "text", text }],
          api: "cli",
          provider: "claude-cli",
          model: "claude-opus-5-5",
          stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          timestamp: Date.parse(iso),
        } as never),
  );
}

function entry(): SessionEntry {
  return {
    sessionId: "s-1",
    updatedAt: 0,
    totalTokens: 900_000,
    cliSessionBindings: { "claude-cli": { sessionId: "claude-1" } },
  } as SessionEntry;
}

function rememberTurn(extra: Partial<RunCliAgentParams> = {}) {
  rememberCliDaySummaryReplay(
    {
      trigger: "user",
      provider: "claude-cli",
      agentId: "main",
      sessionKey,
      sessionId: "s-1",
      sessionFile: sessionKey,
      workspaceDir: "/var/lib/arxi/owner-vault",
      prompt: "OWNER_TEXT",
      runId: "owner-run",
      model: "claude-opus-5-5",
      extraSystemPrompt: "SYSTEM",
      abortSignal: new AbortController().signal,
      onBlockReply: () => {},
      ...extra,
    } as RunCliAgentParams,
    {
      appendSystemContext: "STATE_GUIDANCE",
      prependContext: "PER_TURN",
      hasPendingNonPromptBuildContext: false,
    },
  );
}

function run(nowIso: string, extra: Partial<Parameters<typeof runCliDayCompactionIfDue>[0]> = {}) {
  const current = entry();
  return runCliDayCompactionIfDue({
    cfg,
    agentId: "main",
    sessionKey,
    storePath: "/tmp/store",
    entry: current,
    sessionStore: { [sessionKey]: current },
    isHeartbeat: false,
    assertActive: () => {},
    nowMs: Date.parse(nowIso),
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCliDaySummaryReplaysForTest();
  mocks.runCliAgent.mockReset();
  mocks.recordCliCompactionInStore.mockReset();
  mocks.recordCliCompactionInStore.mockResolvedValue({ sessionId: "s-1", compactionCount: 1 });
  const manager = SessionManager.inMemory();
  mocks.manager = manager;
  vi.spyOn(SessionManager, "openBoundedAsync").mockImplementation(async () => manager);
  say(manager, "2026-11-17T10:00:00Z", "user", "yesterday");
  say(manager, "2026-11-17T10:01:00Z", "assistant", "done");
  say(manager, "2026-11-18T08:00:00Z", "user", "today");
  say(manager, "2026-11-18T08:01:00Z", "assistant", "sure");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runCliDayCompactionIfDue", () => {
  it("reads only the bounded window since the latest boundary", async () => {
    rememberTurn();
    mocks.runCliAgent.mockResolvedValue({
      payloads: [{ text: "x" }],
      meta: {
        finalAssistantVisibleText:
          '```json\n{"days":[{"date":"2026-11-17","summary":"Yesterday."}],"turns":[{"id":"t1","note":"none"}]}\n```',
      },
    });
    await run("2026-11-18T08:59:00Z", { coldCacheAhead: true });
    expect(mocks.runCliAgent).toHaveBeenCalledOnce();
    const opens = vi.mocked(SessionManager.openBoundedAsync).mock.calls;
    // The plan's read and the writer's read.
    expect(opens).toHaveLength(2);
    for (const call of opens) {
      expect(call[1]).toMatchObject({ fromLatestBoundary: true });
      expect(call[1].maxBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      // The bounded readers refuse anything above this.
      expect(call[1].maxEvents).toBeLessThanOrEqual(MAX_VISIBLE_MESSAGE_MAX_MESSAGES);
    }
  });

  it("keeps the conversation when a cut window lost the latest boundary", async () => {
    rememberTurn();
    const manager = mocks.manager!;
    vi.mocked(SessionManager.openBoundedAsync).mockImplementation(async (_target, options) => {
      options.onTruncated?.();
      return manager;
    });
    vi.spyOn(manager, "getBoundaryCount").mockReturnValue(1);
    await run("2026-11-18T08:59:00Z", { coldCacheAhead: true });
    expect(mocks.runCliAgent).not.toHaveBeenCalled();
    expect(mocks.recordCliCompactionInStore).not.toHaveBeenCalled();
  });

  it("asks the warm session silently, writes the boundary and ends the native session", async () => {
    rememberTurn();
    mocks.runCliAgent.mockResolvedValue({
      payloads: [{ text: "x" }],
      meta: {
        finalAssistantVisibleText:
          '```json\n{"days":[{"date":"2026-11-17","summary":"Yesterday."}],"turns":[{"id":"t1","note":"none"}]}\n```',
      },
    });
    const notDue = vi.fn();
    const onStart = vi.fn();
    await run("2026-11-18T08:59:00Z", {
      coldCacheAhead: true,
      onColdCacheNotDue: notDue,
      onCompactionStart: onStart,
    });
    expect(notDue).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledOnce();
    const call = mocks.runCliAgent.mock.calls[0]?.[0] as RunCliAgentParams;
    expect(call).toMatchObject({
      controlOperation: "day-summary",
      trigger: "user",
      provider: "claude-cli",
      extraSystemPrompt: "SYSTEM",
      cliSessionId: "claude-1",
      persistAssistantTranscript: false,
      sessionId: "s-1",
    });
    expect(call.prompt).toContain("2026-11-17, Tuesday");
    expect(call.runId).not.toBe("owner-run");
    expect(call).not.toHaveProperty("onBlockReply");
    const boundary = mocks.manager!.getBranch().at(-1);
    expect(boundary).toMatchObject({
      type: "compaction",
      details: { kind: "openclaw.cli-days", days: [{ date: "2026-11-17", summary: "Yesterday." }] },
    });
    expect(mocks.recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({ compactionKind: "context-engine", sessionKey }),
    );
  });

  it("rearms the background run before its time and leaves a warm cache to the next turn", async () => {
    rememberTurn();
    const notDue = vi.fn();
    await run("2026-11-18T08:31:00Z", { coldCacheAhead: true, onColdCacheNotDue: notDue });
    expect(notDue).toHaveBeenCalledWith(27 * 60_000);
    await run("2026-11-18T08:40:00Z");
    expect(mocks.runCliAgent).not.toHaveBeenCalled();
  });

  it("keeps the conversation when the summary misses a day", async () => {
    rememberTurn();
    mocks.runCliAgent.mockResolvedValue({ meta: { finalAssistantVisibleText: '{"days":[]}' } });
    const before = mocks.manager!.getBranch().length;
    await run("2026-11-18T10:00:00Z");
    expect(mocks.runCliAgent).toHaveBeenCalledOnce();
    expect(mocks.manager!.getBranch()).toHaveLength(before);
    expect(mocks.recordCliCompactionInStore).not.toHaveBeenCalled();
  });

  it("keeps the message being answered when the first turn of a new day condenses", async () => {
    rememberTurn();
    mocks.runCliAgent.mockResolvedValue({
      meta: {
        finalAssistantVisibleText:
          '{"days":[{"date":"2026-11-17","summary":"Yesterday."},{"date":"2026-11-18","summary":"Morning."}]}',
      },
    });
    const pending = say(mocks.manager!, "2026-11-19T09:00:00Z", "user", "new day");
    const current = { ...entry(), updatedAt: Date.parse("2026-11-19T09:00:00Z") };
    await runCliDayCompactionIfDue({
      cfg,
      agentId: "main",
      sessionKey,
      storePath: "/tmp/store",
      entry: current,
      sessionStore: { [sessionKey]: current },
      isHeartbeat: false,
      assertActive: () => {},
      pendingUserEntryId: pending,
      nowMs: Date.parse("2026-11-19T09:00:01Z"),
    });
    expect(mocks.runCliAgent).toHaveBeenCalledOnce();
    expect(mocks.manager!.getBranch().at(-1)).toMatchObject({
      type: "compaction",
      firstKeptEntryId: pending,
    });
  });

  it("does nothing without a person turn to continue", async () => {
    await run("2026-11-18T10:00:00Z");
    expect(mocks.runCliAgent).not.toHaveBeenCalled();
  });
});
