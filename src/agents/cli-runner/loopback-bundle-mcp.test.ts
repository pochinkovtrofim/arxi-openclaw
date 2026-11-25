import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareCliLoopbackBundleMcp } from "./loopback-bundle-mcp.js";
import { buildCliMcpGrantContext } from "./mcp-grant-context.js";
import type { RunCliAgentParams } from "./types.js";

const mocks = vi.hoisted(() => ({
  acquireSessionMcpRuntime: vi.fn(),
  materializeBundleMcpToolsForRun: vi.fn(),
}));

vi.mock("../agent-bundle-mcp-tools.js", () => ({
  acquireSessionMcpRuntime: mocks.acquireSessionMcpRuntime,
  materializeBundleMcpToolsForRun: mocks.materializeBundleMcpToolsForRun,
}));

vi.mock("../agent-bundle-mcp-runtime-config.js", () => ({
  loadSessionMcpConfig: () => ({
    loaded: { mcpServers: { google_workspace: { url: "http://127.0.0.1:18080/mcp" } } },
    safeServerNamesByServer: new Map([["google_workspace", "google_workspace"]]),
  }),
}));

const config = { mcp: { servers: { google_workspace: {} } } } as unknown as OpenClawConfig;

async function acquiredFor(run: Partial<RunCliAgentParams>) {
  const prepared = await prepareCliLoopbackBundleMcp({
    run: { sessionId: "session-1", sessionKey: "agent:main:main", ...run } as RunCliAgentParams,
    config,
    workspaceDir: "/workspace",
    agentId: "main",
    agentDir: "/agent",
    resolveCapabilityProfile: async () => ({ policy: { explicitToolDenylist: [] } }) as never,
  });
  await prepared?.[Symbol.asyncDispose]();
  expect(mocks.acquireSessionMcpRuntime).toHaveBeenCalledOnce();
  return mocks.acquireSessionMcpRuntime.mock.calls[0]?.[0];
}

describe("prepareCliLoopbackBundleMcp requester identity", () => {
  beforeEach(() => {
    mocks.acquireSessionMcpRuntime.mockReset().mockResolvedValue({
      runtime: { peekCatalog: () => undefined },
      releaseLease: () => {},
    });
    mocks.materializeBundleMcpToolsForRun
      .mockReset()
      .mockResolvedValue({ tools: [], dispose: async () => {} });
  });

  it("acquires MCP for the conversation and sender the turn's tool hooks see", async () => {
    const run = {
      chatId: "telegram-chat:45117910",
      chatType: "direct",
      senderId: "45117910",
      messageChannel: "arxi",
      currentChannelId: "owner",
    } satisfies Partial<RunCliAgentParams>;
    const acquired = await acquiredFor(run);
    const { requester } = buildCliMcpGrantContext({
      run: { sessionKey: "agent:main:main", ...run } as RunCliAgentParams,
      config,
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "anthropic",
      modelId: "claude-opus-5-5",
    });
    // An approval its hook binds to this chat is executed by a call from this chat.
    expect({
      conversationId: acquired.conversationId,
      chatType: acquired.chatType,
      senderId: acquired.requesterSenderId,
    }).toEqual({
      conversationId: requester?.conversationId,
      chatType: requester?.chatType,
      senderId: requester?.senderId,
    });
    expect(acquired.conversationId).toBe("telegram-chat:45117910");
    expect(acquired.requesterSenderId).toBe("45117910");
  });

  it("keeps a run without a sender on background identity", async () => {
    const acquired = await acquiredFor({ messageChannel: "arxi" });
    expect(acquired.requesterSenderId).toBeUndefined();
    expect(acquired.conversationId).toBeUndefined();
  });

  it("keeps per-run facts out of the session's shared runtime", async () => {
    const acquired = await acquiredFor({
      chatId: "telegram-chat:1",
      senderId: "1",
      lifecycleGeneration: "gen-7",
    } as Partial<RunCliAgentParams>);
    expect(acquired).not.toHaveProperty("runtimeGeneration");
    expect(acquired).not.toHaveProperty("traceId");
  });
});
