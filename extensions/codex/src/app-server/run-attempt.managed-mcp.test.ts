import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createStartedThreadHarness,
  createRuntimeDynamicTool,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
type RuntimeDynamicToolForTest = ReturnType<typeof createRuntimeDynamicTool>;
const agentHarnessRuntimeMocks = vi.hoisted(() => ({
  forceModelToolsUnsupported: false,
  skipRequesterScopedMcpMaterialization: false,
  scopedTools: undefined as RuntimeDynamicToolForTest[] | undefined,
  requesterScopedMcpCalls: [] as Array<{
    toolOverrides?: { mcpServers?: Record<string, boolean> };
  }>,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    supportsModelTools: (...args: Parameters<typeof actual.supportsModelTools>) =>
      agentHarnessRuntimeMocks.forceModelToolsUnsupported
        ? false
        : actual.supportsModelTools(...args),
    materializeRequesterScopedMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeRequesterScopedMcpToolsForHarnessRun>
    ) => {
      agentHarnessRuntimeMocks.requesterScopedMcpCalls.push(args[0]);
      if (agentHarnessRuntimeMocks.scopedTools) {
        return {
          tools: agentHarnessRuntimeMocks.scopedTools,
          advertisedTools: agentHarnessRuntimeMocks.scopedTools,
          allocatedToolNames: agentHarnessRuntimeMocks.scopedTools.map((tool) => tool.name),
          dispose: async () => undefined,
        };
      }
      if (agentHarnessRuntimeMocks.skipRequesterScopedMcpMaterialization) {
        return undefined;
      }
      return await actual.materializeRequesterScopedMcpToolsForHarnessRun(...args);
    },
  };
});

setupRunAttemptTestHooks();
beforeEach(() => {
  agentHarnessRuntimeMocks.scopedTools = undefined;
  agentHarnessRuntimeMocks.requesterScopedMcpCalls.length = 0;
});
function createRunPaths() {
  return {
    sessionFile: path.join(tempDir, "session.jsonl"),
    workspaceDir: path.join(tempDir, "workspace"),
  };
}
describe("Arxi requester-scoped MCP admission", () => {
  it("binds scoped MCP execution to the current host capability", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const harness = createStartedThreadHarness();
    const tool = createRuntimeDynamicTool("mail__send");
    agentHarnessRuntimeMocks.scopedTools = [tool];
    const params = createParams(sessionFile, workspaceDir);
    const bind = vi.fn((tools: typeof agentHarnessRuntimeMocks.scopedTools) =>
      (tools ?? []).map((source) =>
        Object.assign({}, source, {
          execute: async () => {
            throw new Error("current host capability has closed");
          },
        }),
      ),
    );
    params.hostCapabilities = { ...params.hostCapabilities, bindToolSurface: bind };
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const response = await harness.handleServerRequest({
      id: "mcp-bound-host",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "mcp-bound-call",
        namespace: null,
        tool: tool.name,
        arguments: {},
      },
    });
    expect(bind).toHaveBeenCalledWith([tool], { cwd: workspaceDir });
    expect(response).toMatchObject({ success: false });
    expect(JSON.stringify(response)).toContain("current host capability has closed");
    expect(tool.execute).not.toHaveBeenCalled();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });
  it("binds requester-scoped MCP hooks to the same admitted conversation as resolution", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const harness = createStartedThreadHarness();
    const tool = createRuntimeDynamicTool("mail__send");
    agentHarnessRuntimeMocks.scopedTools = [tool];
    const hook = vi.fn(async (event, context) =>
      event.toolName === tool.name
        ? { block: true, blockReason: `approval:${context.requester?.conversationId}` }
        : undefined,
    );
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: hook }]),
    );
    const params = createParams(sessionFile, workspaceDir);
    params.senderId = "verified-sender";
    params.chatId = "admitted-conversation";
    params.chatType = "direct";
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const response = await harness.handleServerRequest({
      id: "mcp-approval",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "mcp-call",
        namespace: null,
        tool: tool.name,
        arguments: {},
      },
    });
    expect(response).toMatchObject({ success: false });
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: tool.name }),
      expect.objectContaining({
        requester: expect.objectContaining({
          conversationId: params.chatId,
          chatType: "direct",
          senderId: params.senderId,
        }),
      }),
    );
    expect(tool.execute).not.toHaveBeenCalled();
    expect(agentHarnessRuntimeMocks.requesterScopedMcpCalls).toContainEqual(
      expect.objectContaining({ conversationId: params.chatId }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    closeHost();
  });
});
