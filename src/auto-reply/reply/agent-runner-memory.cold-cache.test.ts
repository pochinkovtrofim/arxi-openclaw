import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionTranscriptAccountingSnapshot } from "../../config/sessions/session-transcript-accounting.types.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";

const { accounting, compact, increment } = vi.hoisted(() => ({
  accounting: vi.fn<() => Promise<SessionTranscriptAccountingSnapshot>>(),
  compact: vi.fn(),
  increment: vi.fn(),
}));
vi.mock("../../gateway/session-transcript-readers.js", () => ({
  readSessionTranscriptAccountingAsync: accounting,
}));
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: vi.fn(),
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compact,
}));
vi.mock("./session-updates.js", () => ({ incrementCompactionCount: increment }));

const MINUTE = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  registerMemoryCapability("memory-core", {
    flushPlanResolver: () => ({
      softThresholdTokens: 4000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20000,
      prompt: "Save memory",
      systemPrompt: "Save memory",
      relativePath: "memory/synthetic.md",
    }),
  });
  compact.mockResolvedValue({ ok: true, compacted: true, result: { tokensAfter: 40_000 } });
  increment.mockResolvedValue(1);
});
afterEach(() => clearMemoryPluginState());

async function runAfterIdle(params: {
  idleMs: number;
  promptTokens?: number;
  provider?: string;
  model?: string;
  compaction?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["compaction"];
  cacheRetention?: "short" | "long";
}) {
  const provider = params.provider ?? "anthropic";
  const model = params.model ?? "claude-opus-5-5";
  const promptTokens = params.promptTokens ?? 600_000;
  accounting.mockResolvedValue({
    byteSize: 1000,
    eventCount: 40,
    usage: {
      promptTokens,
      outputTokens: 500,
      observedAt: Date.now() - params.idleMs,
      trailingMessages: [],
    },
  });
  const followupRun = createTestFollowupRun({ provider, model });
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        compaction: { memoryFlush: {}, ...params.compaction },
        models: {
          [`${provider}/${model}`]: {
            params: { cacheRetention: params.cacheRetention ?? "long" },
          },
        },
      },
    },
  };
  return await runSessionCompactionIfNeeded({
    followupRun,
    defaultModel: `${provider}/${model}`,
    sessionEntry: {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: promptTokens,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    },
    sessionKey: "main",
    storePath: path.join(followupRun.run.workspaceDir, "sessions.json"),
    isHeartbeat: false,
    cfg: withTestModelContextTokens({
      cfg,
      followupRun,
      defaultModel: `${provider}/${model}`,
      contextTokens: 1_000_000,
    }),
  });
}

it("compacts a large session whose long-retention prompt cache has expired", async () => {
  await runAfterIdle({ idleMs: 61 * MINUTE });
  expect(compact).toHaveBeenCalledOnce();
  expect(compact.mock.calls[0]?.[0]).toMatchObject({ forcePreflight: true });
});

it("keeps a large session whose prompt cache is still warm", async () => {
  await runAfterIdle({ idleMs: 37 * MINUTE });
  expect(compact).not.toHaveBeenCalled();
});

it("dates short retention at five minutes", async () => {
  await runAfterIdle({ idleMs: 9 * MINUTE, cacheRetention: "short" });
  expect(compact).toHaveBeenCalledOnce();
});

it("keeps a session below the cold-cache threshold", async () => {
  await runAfterIdle({ idleMs: 3 * 60 * MINUTE, promptTokens: 120_000 });
  expect(compact).not.toHaveBeenCalled();
});

it("honors a configured threshold and its zero switch", async () => {
  await runAfterIdle({ idleMs: 2 * 60 * MINUTE, compaction: { coldCacheTokens: 0 } });
  expect(compact).not.toHaveBeenCalled();
  await runAfterIdle({
    idleMs: 2 * 60 * MINUTE,
    promptTokens: 120_000,
    compaction: { coldCacheTokens: 100_000 },
  });
  expect(compact).toHaveBeenCalledOnce();
});

it("leaves routes without a known prompt-cache lifetime alone", async () => {
  await runAfterIdle({ idleMs: 2 * 60 * MINUTE, provider: "openrouter", model: "some-model" });
  expect(compact).not.toHaveBeenCalled();
});

it.each([
  ["rejects", () => compact.mockRejectedValue(new Error("provider overloaded"))],
  [
    "reports failure",
    () => compact.mockResolvedValue({ ok: false, compacted: false, reason: "provider overloaded" }),
  ],
] as const)("replies uncompacted when cold-cache compaction %s", async (_name, arrange) => {
  arrange();
  const entry = await runAfterIdle({ idleMs: 2 * 60 * MINUTE });
  expect(compact).toHaveBeenCalledOnce();
  expect(entry).toMatchObject({ sessionId: "session", totalTokens: 600_000 });
});
