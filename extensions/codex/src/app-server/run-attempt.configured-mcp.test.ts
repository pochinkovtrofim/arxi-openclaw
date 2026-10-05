import { getEventListeners } from "node:events";
import "./run-attempt.configured-mcp.test-support.js";
import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import * as attemptContext from "./attempt-context.js";
import * as dynamicTools from "./dynamic-tools.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";
import {
  assistantMessage,
  createParams,
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const { configureFakeMcp, mcpMocks, setupConfiguredMcpTestHooks } =
  await import("./run-attempt.configured-mcp.test-support.js");

setupConfiguredMcpTestHooks();

function createMcpParams(toolsAllow?: string[]) {
  const params = createTestParams();
  configureFakeMcp(params);
  params.toolsAllow = toolsAllow;
  return params;
}

describe("runCodexAppServerAttempt configured MCP ownership", () => {
  it.each([
    { reason: "cancellation", rejectCleanup: true },
    { reason: "authority closure", rejectCleanup: false },
  ])(
    "disposes acquired MCP handles on history $reason (cleanup rejects=$rejectCleanup)",
    async ({ reason, rejectCleanup }) => {
      const params = createMcpParams(["cron", "fake__show"]);
      mcpMocks.requesterCollisionTool = true;
      if (rejectCleanup) {
        mcpMocks.requesterDispose.mockRejectedValueOnce(new Error("synthetic MCP cleanup failure"));
      }
      const controller = new AbortController();
      params.abortSignal = controller.signal;
      const upstreamListeners = getEventListeners(controller.signal, "abort").length;
      let active = true;
      const hostCapabilities = params.hostCapabilities;
      params.hostCapabilities = Object.freeze({
        ...hostCapabilities,
        assertActive() {
          if (!active) {
            throw new Error("authority closed during model-history preparation");
          }
          hostCapabilities.assertActive();
        },
      });
      const readEntered = createDeferred<void>();
      const readGate = createDeferred<void>();
      const read = vi
        .spyOn(attemptContext, "readMirroredSessionHistoryMessages")
        .mockImplementationOnce(async () => {
          readEntered.resolve();
          await readGate.promise;
          return [];
        });
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      const rejected = expect(run).rejects.toThrow("during model-history preparation");
      try {
        await readEntered.promise;
        expect(mcpMocks.staticCalls).toHaveLength(1);
        expect(mcpMocks.requesterCalls).toBe(1);
        if (reason === "cancellation") {
          controller.abort(new Error("cancelled during model-history preparation"));
        } else {
          active = false;
        }
        readGate.resolve();
        await rejected;
        expect(mcpMocks.dispose).toHaveBeenCalledOnce();
        expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
        expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(upstreamListeners);
      } finally {
        readGate.resolve();
        await run.catch(() => undefined);
        read.mockRestore();
      }
    },
  );

  it("preserves the setup failure and disposes both MCP handles when the first disposal rejects", async () => {
    const params = createMcpParams(["cron", "fake__show"]);
    mcpMocks.requesterCollisionTool = true;
    const failure = new Error("synthetic dynamic bridge failure");
    const bridge = vi
      .spyOn(dynamicTools, "createCodexDynamicToolBridge")
      .mockImplementationOnce(() => {
        throw failure;
      });
    mcpMocks.requesterDispose.mockRejectedValueOnce(new Error("synthetic MCP cleanup failure"));
    const harness = createStartedThreadHarness();
    try {
      const result = await runCodexAppServerAttempt(params).catch((error: unknown) => error);
      expect(result).toBe(failure);
      expect(mcpMocks.dispose).toHaveBeenCalledOnce();
      expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
      expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
    } finally {
      bridge.mockRestore();
    }
  });

  it("releases the upstream abort listener when tool preparation fails before ownership transfer", async () => {
    const params = createMcpParams(["cron", "fake__show"]);
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    const upstreamListeners = getEventListeners(controller.signal, "abort").length;
    const failure = new Error("synthetic tool materialization failure");
    mcpMocks.staticFailure = failure;
    const harness = createStartedThreadHarness();

    await expect(runCodexAppServerAttempt(params)).rejects.toBe(failure);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(upstreamListeners);
    expect(mcpMocks.dispose).not.toHaveBeenCalled();
    expect(mcpMocks.requesterDispose).not.toHaveBeenCalled();
    expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("disposes both acquired MCP handles once when native startup fails", async () => {
    const params = createMcpParams(["cron", "fake__show"]);
    mcpMocks.requesterCollisionTool = true;
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    const upstreamListeners = getEventListeners(controller.signal, "abort").length;
    const failure = new Error("synthetic native startup failure");
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        throw failure;
      }
      return undefined;
    });

    await expect(runCodexAppServerAttempt(params)).rejects.toBe(failure);

    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(upstreamListeners);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("preserves bounded canonical continuity when scheduled MCP replaces ordinary ownership", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-mcp-ownership-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-scheduled-mcp-ownership-continuity");
    const cutoff = Date.now();
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-ordinary",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      mcpServersFingerprint: "configured-mcp-test-fixture",
      historyCoveredThrough: new Date(cutoff).toISOString(),
    });
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(userMessage("ordinary-thread covered context", cutoff - 1_000));
    for (let index = 0; index < 10; index += 1) {
      sessionManager.appendMessage(
        assistantMessage(
          `scheduled ownership continuity block ${index}: ${"x".repeat(128_000)}`,
          cutoff + 2_000 + index,
        ),
      );
    }
    sessionManager.appendMessage(userMessage("new scheduled ownership question", cutoff + 20_000));
    sessionManager.appendMessage(
      assistantMessage("recent scheduled ownership answer", cutoff + 21_000),
    );

    const params = createParams(sessionFile, workspaceDir);
    configureFakeMcp(params);
    params.prompt = "continue after the scheduled ownership transition";
    params.trigger = "cron";
    params.toolsAllow = ["*"];
    params.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-ordinary",
        });
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: Record<string, unknown>; dynamicTools?: unknown } | undefined;
    expect(mcpMocks.requesterCalls).toBe(0);
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(threadStart?.config).not.toHaveProperty("mcp_servers");
    expect(JSON.stringify(threadStart?.config ?? {})).not.toContain("fake-mcp");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("fake__show");
    expect(mcpMocks.staticCalls[0]).not.toHaveProperty("requesterSenderId");
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      toolsAllow: ["*"],
      autoApproveCodexAppServerApprovals: true,
    });
    const toolResult = await harness.handleServerRequest({
      id: "request-fake-ping",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-fake-ping",
        namespace: null,
        tool: "fake__show",
        arguments: {},
      },
    });
    expect(toolResult).toMatchObject({ success: true });
    expect(JSON.stringify(toolResult)).toContain("initial-result");
    expect(mcpMocks.staticToolExecutes[0]).toHaveBeenCalledOnce();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(harness.requests.map((request) => request.method)).toContain("thread/start");
    expect(harness.requests.map((request) => request.method)).not.toContain("thread/resume");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText.length).toBeLessThanOrEqual(1 << 20);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("new scheduled ownership question");
    expect(inputText).toContain("recent scheduled ownership answer");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("continue after the scheduled ownership transition");
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    expect(mcpMocks.captureCalls[0]).toMatchObject({
      storedNames: expect.arrayContaining(["fake__show"]),
      provenance: { version: 1, source: "final-executable-surface" },
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).toMatchObject({ threadId: "thread-1", configuredMcpOwnershipVersion: 1 });
    expect(binding).not.toHaveProperty("mcpServersFingerprint");
    expect(binding).not.toHaveProperty("userMcpServersFingerprint");
  });

  it.each([
    { mode: "auto", source: "operator", delegate: true },
    { mode: "prompt", source: "bundle", delegate: true },
    { mode: "approve", source: "operator-over-bundle", delegate: false },
  ] as const)(
    "honors $source MCP approval mode $mode at thread and turn startup",
    async (testCase) => {
      const params = createMcpParams();
      params.config!.mcp!.servers!.fake!.codex = { defaultToolsApprovalMode: testCase.mode };
      if (testCase.source === "bundle") {
        params.config!.mcp = {};
        mcpMocks.threadConfigFacade.mockReturnValueOnce({
          configPatch: {
            mcp_servers: {
              bundled: {
                url: "https://mcp.example.test",
                default_tools_approval_mode: testCase.mode,
              },
            },
          },
          diagnostics: [],
          evaluated: true,
          staticServerNames: ["bundled", "unannotated"],
          requesterScopedServerNames: [],
          userStaticServerNames: ["unannotated"],
        });
      } else if (testCase.source === "operator-over-bundle") {
        mcpMocks.threadConfigFacade.mockReturnValueOnce({
          configPatch: {
            mcp_servers: {
              fake: { url: "https://mcp.example.test", default_tools_approval_mode: "prompt" },
            },
          },
          diagnostics: [],
          evaluated: true,
          staticServerNames: ["fake", "unannotated"],
          requesterScopedServerNames: [],
          userStaticServerNames: ["fake", "unannotated"],
        });
      }
      params.config!.mcp!.servers = {
        ...params.config!.mcp!.servers,
        unannotated: { url: "https://unannotated.example.test/mcp" },
      };
      const requestApproval = vi.fn(async (_request: { description?: string }) => ({
        id: "plugin:mcp-fixture",
      }));
      const waitForApproval = vi.fn(async () => ({
        decision: "deny" as const,
        terminalReason: "user" as const,
      }));
      params.hostCapabilities = Object.freeze({
        ...params.hostCapabilities,
        requestApproval,
        waitForApproval,
      });

      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
        },
      });
      await harness.waitForMethod("turn/start");
      const responses = [];
      for (const serverName of ["unannotated", testCase.source === "bundle" ? "bundled" : "fake"]) {
        responses.push(
          await harness.handleServerRequest({
            id: `approval-${serverName}`,
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              serverName,
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call" },
              requestedSchema: { type: "object", properties: {} },
            },
          }),
        );
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();

      expect(responses).toEqual([
        { action: "accept", content: null, _meta: null },
        { action: testCase.delegate ? "decline" : "accept", content: null, _meta: null },
      ]);
      expect(requestApproval).toHaveBeenCalledTimes(testCase.delegate ? 1 : 0);
      expect(waitForApproval).toHaveBeenCalledTimes(testCase.delegate ? 1 : 0);
      // Codex drops decline meta, so the remedy must reach the operator via the card.
      if (testCase.delegate) {
        expect(requestApproval.mock.calls[0]?.[0]?.description).toContain(
          `openclaw mcp configure ${testCase.source === "bundle" ? "bundled" : "fake"} --approval approve`,
        );
      }
      const expectedApprovalPolicy = testCase.delegate
        ? {
            granular: {
              mcp_elicitations: true,
              rules: false,
              sandbox_approval: false,
              request_permissions: false,
              skill_approval: false,
            },
          }
        : "never";
      for (const method of ["thread/start", "turn/start"]) {
        expect(harness.requests.find((request) => request.method === method)?.params).toMatchObject(
          {
            approvalPolicy: expectedApprovalPolicy,
          },
        );
      }
      expect(harness.requests.map((request) => request.method)).not.toContain(
        "mcpServerStatus/list",
      );
      expect(mcpMocks.staticCalls).toHaveLength(0);
      expect(mcpMocks.requesterParams[0]?.manifestRegistry).toBe(
        params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      );
      expect(mcpMocks.captureCalls).toHaveLength(1);
      expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
    },
  );

  it("keeps configured and requester MCP unique when the native surface is unavailable", async () => {
    const params = createMcpParams();
    params.config!.mcp!.servers!.fake!.codex = { defaultToolsApprovalMode: "auto" };
    params.toolsAllow = ["cron", "fake__show"];
    mcpMocks.requesterCollisionTool = true;
    const requestApproval = vi.fn(async (request: { isMcpToolApprovalActive?: () => boolean }) => {
      expect(request.isMcpToolApprovalActive?.()).toBe(true);
      return { id: "plugin:mcp-dynamic" };
    });
    const waitForApproval = vi.fn(async () => ({
      decision: "allow-always" as const,
      terminalReason: "user" as const,
    }));
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      requestApproval,
      waitForApproval,
    });

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as
      | { config?: Record<string, unknown>; dynamicTools?: CodexDynamicToolSpec[] }
      | undefined;
    const dynamicNames = flattenCodexDynamicToolFunctions(threadStart?.dynamicTools).map(
      (tool) => tool.name,
    );
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      agentId: "main",
      projectedMcpServers: expect.objectContaining({ fake: expect.any(Object) }),
      requestInteractiveCodexApproval: expect.any(Function),
    });
    expect(threadStart?.config).not.toHaveProperty("mcp_servers");
    expect(dynamicNames.filter((name) => name === "fake__show")).toHaveLength(1);
    expect(dynamicNames.filter((name) => name === "fake__show-2")).toHaveLength(1);

    const requestInteractiveCodexApproval = mcpMocks.staticCalls[0]!
      .requestInteractiveCodexApproval as (params: {
      safeToolName: string;
      toolCallId: string;
      serverName: string;
      toolName: string;
      mode: "auto";
      isActive: () => boolean;
    }) => Promise<void>;
    await requestInteractiveCodexApproval({
      safeToolName: "fake__show-2",
      toolCallId: "call-fake-show",
      serverName: "fake",
      toolName: "show",
      mode: "auto",
      isActive: () => true,
    });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        mcpTool: { server: "fake", tool: "show" },
        toolCallId: "call-fake-show",
      }),
    );
    expect(waitForApproval).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(harness.requests.map((request) => request.method)).not.toContain("mcpServerStatus/list");
    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]!.storedNames).toEqual(
      expect.arrayContaining(["fake__show", "fake__show-2"]),
    );
    expect(new Set(mcpMocks.captureCalls[0]!.storedNames).size).toBe(
      mcpMocks.captureCalls[0]!.storedNames.length,
    );
    expect(mcpMocks.captureCalls[0]!.provenance).toEqual({
      version: 1,
      source: "final-executable-surface",
    });
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
  });
  it.each(["current hook policy", ""])(
    "keeps post-hook static discovery failures visible with replacement policy %j",
    async (systemPrompt) => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_prompt_build", handler: async () => ({ systemPrompt }) },
        ]),
      );
      const sessionFile = path.join(tempDir, "session-static-mcp-discovery-failure.jsonl");
      const params = createParams(
        sessionFile,
        path.join(tempDir, "workspace-static-mcp-discovery-failure"),
      );
      configureFakeMcp(params);
      params.trigger = "cron";
      params.toolsAllow = ["*"];
      params.scheduledToolPolicy = { version: 1, mode: "trusted" };
      mcpMocks.staticDiagnosticNotice =
        "Configured MCP is incomplete for this scheduled run: fake: authentication required. " +
        "Do not claim MCP-backed work succeeded; report this blocker to the operator.";

      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      const threadStart = harness.requests.find((request) => request.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        developerInstructions: [systemPrompt, mcpMocks.staticDiagnosticNotice]
          .filter(Boolean)
          .join("\n\n"),
      });
      expect(harness.requests.some((request) => request.method === "thread/inject_items")).toBe(
        false,
      );
      expect(mcpMocks.captureCalls).toHaveLength(1);
      expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();
      expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    },
  );

  it("projects requesterless resolvers for account-owned scheduled runs without replaying requester identity", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-background-resolver.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-background-resolver"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["fake__show", "resolver__read"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
      mcpToolBindings: [
        {
          name: "fake__show",
          serverName: "static",
          operation: "tool",
          toolName: "fake__show",
        },
        {
          name: "resolver__read",
          serverName: "requester",
          operation: "tool",
          toolName: "resolver__read",
        },
      ],
    };
    params.senderId = "owner:must-not-be-replayed";
    params.agentAccountId = "default";
    params.messageChannel = "arxi";
    params.chatType = "direct";
    params.chatId = "telegram-chat:42";
    mcpMocks.requesterScopedServerNames.push("resolver");
    mcpMocks.requesterToolNames.push("resolver__read");

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools?: unknown } | undefined;
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("fake__show");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("resolver__read");
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.requesterCalls).toBe(1);
    expect(mcpMocks.requesterParams[0]).toMatchObject({
      sessionKey: params.sessionKey,
      agentId: "main",
      toolsAllow: ["fake__show", "resolver__read"],
      reservedToolNames: expect.not.arrayContaining(["fake__show"]),
      scheduledCodexApproval: { autoApprove: true },
    });
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      reservedToolNames: expect.arrayContaining(["resolver__read"]),
    });
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("requesterSenderId");
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("agentAccountId");
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("messageChannel");
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("chatType");
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("conversationId");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
  });

  it.each([["*"], ["resolver__read"]])(
    "projects requesterless resolvers for trusted scheduled runs under cap %j",
    async (grant) => {
      const sessionFile = path.join(tempDir, "session-trusted-background-resolver.jsonl");
      const params = createParams(sessionFile, path.join(tempDir, "workspace-trusted-background"));
      configureFakeMcp(params);
      params.trigger = "cron";
      params.toolsAllow = [grant];
      params.scheduledToolPolicy = { version: 1, mode: "trusted" };
      params.senderId = "owner:must-not-be-replayed";
      params.agentAccountId = "default";
      params.messageChannel = "arxi";
      params.chatType = "direct";
      params.chatId = "telegram-chat:42";
      mcpMocks.requesterScopedServerNames.push("resolver");
      mcpMocks.requesterToolNames.push("resolver__read");

      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
        },
      });
      await harness.waitForMethod("turn/start");
      const threadStart = harness.requests.find((request) => request.method === "thread/start")
        ?.params as { dynamicTools?: unknown } | undefined;
      expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("resolver__read");
      expect(mcpMocks.requesterParams[0]).toMatchObject({
        agentId: "main",
        sessionKey: params.sessionKey,
        toolsAllow: [grant],
        scheduledCodexApproval: { autoApprove: true },
      });
      for (const field of [
        "requesterSenderId",
        "agentAccountId",
        "messageChannel",
        "chatType",
        "conversationId",
      ]) {
        expect(mcpMocks.requesterParams[0]).not.toHaveProperty(field);
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();
      expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
    },
  );

  it("rejects a configured tool that takes a disappeared resolver's persisted name", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-background-collision.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-background-collision"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["a__b__c", "resolver__other"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
      mcpToolBindings: [
        {
          name: "a__b__c",
          serverName: "requester",
          operation: "tool",
          toolName: "a__b__c",
        },
        {
          name: "resolver__other",
          serverName: "requester",
          operation: "tool",
          toolName: "resolver__other",
        },
      ],
    };
    mcpMocks.requesterScopedServerNames.push("resolver");
    mcpMocks.requesterToolNames.push("resolver__other");
    mcpMocks.staticBaseToolName = "a__b__c";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    expect(mcpMocks.materializationOrder.slice(0, 2)).toEqual(["resolver", "static"]);
    expect(mcpMocks.staticProducedToolNames).toEqual(["a__b__c"]);
    expect(mcpMocks.requesterParams[0]).toMatchObject({
      reservedToolNames: expect.not.arrayContaining(["resolver__other"]),
    });
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      reservedToolNames: expect.arrayContaining(["resolver__other"]),
    });
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools?: unknown } | undefined;
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).not.toContain("a__b__c");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("resolver__other");
    expect(JSON.stringify(threadStart ?? {})).toContain(
      "persisted tool identity no longer matches",
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("does not transfer a persisted MCP name to an ordinary dynamic tool", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-mcp-dynamic-takeover.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-mcp-dynamic-takeover"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["automations"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
      mcpToolBindings: [
        {
          name: "automations",
          serverName: "static",
          operation: "tool",
          toolName: "automations",
        },
      ],
    };
    mcpMocks.staticBaseToolName = "automations";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    expect(mcpMocks.staticProducedToolNames).toEqual(["automations-2"]);
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools?: Array<{ name?: string }> } | undefined;
    const dynamicToolNames = threadStart?.dynamicTools?.map((tool) => tool.name) ?? [];
    expect(dynamicToolNames).not.toContain("automations");
    expect(dynamicToolNames).not.toContain("automations-2");
    expect(JSON.stringify(threadStart ?? {})).toContain(
      "persisted tool identity no longer matches",
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("quarantines a legacy MCP-shaped name when an ordinary dynamic tool takes it", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-legacy-mcp-takeover.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-legacy-mcp-takeover"),
    );
    configureFakeMcp(params);
    params.config = { ...params.config, mcp: { servers: {} } };
    params.trigger = "cron";
    params.toolsAllow = ["legacy__lookup"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
    };
    mcpMocks.ordinaryToolNames.push("legacy__lookup");

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools?: Array<{ name?: string }> } | undefined;
    const dynamicToolNames = threadStart?.dynamicTools?.map((tool) => tool.name) ?? [];
    expect(dynamicToolNames).not.toContain("legacy__lookup");
    expect(mcpMocks.staticCalls).toEqual([]);
    expect(JSON.stringify(threadStart ?? {})).toContain(
      "persisted tool identity no longer matches",
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("keeps background resolver failures visible to the scheduled agent", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-background-resolver-failure.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-background-resolver-failure"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["fake__show", "resolver__read"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
      mcpToolBindings: [
        {
          name: "fake__show",
          serverName: "static",
          operation: "tool",
          toolName: "fake__show",
        },
        {
          name: "resolver__read",
          serverName: "requester",
          operation: "tool",
          toolName: "resolver__read",
        },
      ],
    };
    mcpMocks.requesterScopedServerNames.push("resolver");
    mcpMocks.requesterDiagnosticNotice =
      "Configured MCP is incomplete for this scheduled run: resolver: background connection unavailable. " +
      "Do not claim MCP-backed work succeeded; report this blocker to the operator.";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "workspace-write" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(JSON.stringify(threadStart?.params)).toContain("background connection unavailable");
    expect(mcpMocks.requesterParams[0]).toMatchObject({
      scheduledCodexApproval: { autoApprove: false },
    });
    expect(mcpMocks.staticCalls).toEqual([]);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
  });

  it("keeps normalized wildcard account runs inside the scheduled boundary", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-background-wildcard.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-background-wildcard"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = undefined;
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
    };
    params.senderId = "owner:must-not-be-replayed";
    params.agentAccountId = "default";
    params.messageChannel = "arxi";
    params.chatType = "direct";
    params.chatId = "telegram-chat:42";
    mcpMocks.requesterScopedServerNames.push("resolver");
    mcpMocks.requesterToolNames.push("resolver__read");

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "workspace-write" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(mcpMocks.requesterCalls).toBe(0);
    expect(JSON.stringify(threadStart?.params)).not.toContain("resolver__read");
    expect(JSON.stringify(threadStart?.params)).toContain("no explicit finite toolsAllow");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(mcpMocks.requesterDispose).not.toHaveBeenCalled();
    expect(mcpMocks.staticCalls).toEqual([]);
  });

  it("does not invent a missing-cap resolver blocker when an account run has only static MCP", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-static-wildcard.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-static-wildcard"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = undefined;
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
    };

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "workspace-write" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(mcpMocks.requesterCalls).toBe(0);
    expect(JSON.stringify(threadStart?.params)).not.toContain("no explicit finite toolsAllow");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("keeps ordinary configured MCP native without probing or stamping its inventory", async () => {
    const sessionFile = path.join(tempDir, "session-native-mcp-auth-failure.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-native-mcp-auth-failure"),
    );
    configureFakeMcp(params);
    params.agentId = "main";
    params.senderId = "owner:own_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    params.agentAccountId = "default";
    params.messageChannel = "arxi";
    params.chatType = "direct";
    params.chatId = "telegram-chat:42";
    params.lifecycleGeneration = "63";
    params.diagnosticTrace = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: "01",
    };

    const harness = createStartedThreadHarness(async (method) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "fake",
              serverInfo: null,
              authStatus: "notLoggedIn",
              tools: {},
            },
          ],
          nextCursor: null,
        };
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(harness.requests.map((request) => request.method)).not.toContain("mcpServerStatus/list");
    expect(mcpMocks.staticCalls).toHaveLength(0);
    expect(mcpMocks.requesterParams[0]?.manifestRegistry).toBe(
      params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
    );
    expect(mcpMocks.requesterParams[0]).toMatchObject({
      sessionKey: params.sessionKey,
      agentId: "main",
      requesterSenderId: "owner:own_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agentAccountId: "default",
      messageChannel: "arxi",
      chatType: "direct",
      conversationId: "telegram-chat:42",
      runtimeGeneration: "63",
      traceId: "1234567890abcdef1234567890abcdef",
    });
    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
  });
});
