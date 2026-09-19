/** Behavior tests for harness-facing requester-scoped MCP materialization. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeMcpAppOperation } from "../gateway/mcp-app-operations.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";

const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const startAuthorization = vi.hoisted(() => vi.fn());
const readCredentialsStatus = vi.hoisted(() => vi.fn());

const mocks = vi.hoisted(() => {
  type Runtime = SessionMcpRuntime;
  const advertised = new Map<
    string,
    {
      version: number;
      generatedAt: number;
      servers: Record<string, { serverName: string; launchSummary: string; toolCount: number }>;
      tools: Array<{
        serverName: string;
        safeServerName: string;
        toolName: string;
        description: string;
        inputSchema: Record<string, unknown>;
        fallbackDescription: string;
      }>;
    }
  >();
  const runtimes = new Map<string, Runtime>();
  let resolveImpl:
    | ((params: {
        sessionId: string;
        requesterSenderId?: string | null;
        onResolverUnavailable?: (diagnostic: {
          serverName: string;
          reason: "unavailable" | "timeout" | "error";
        }) => void;
      }) => Promise<Runtime | undefined>)
    | undefined;

  return {
    advertised,
    runtimes,
    setResolveImpl(impl?: typeof resolveImpl) {
      resolveImpl = impl;
    },
    acquireRequesterScopedMcpRuntime: vi.fn(
      async (params: {
        sessionId: string;
        requesterSenderId?: string | null;
        onResolverUnavailable?: (diagnostic: {
          serverName: string;
          reason: "unavailable" | "timeout" | "error";
        }) => void;
      }) => {
        if (resolveImpl) {
          const runtime = await resolveImpl(params);
          return runtime
            ? {
                runtime,
                releaseLease: runtime.acquireLease?.() ?? (() => {}),
                advertisedCatalogConfigFingerprint: runtime.configFingerprint,
              }
            : undefined;
        }
        return undefined;
      },
    ),
    acquireSessionMcpRuntime: vi.fn(),
    rememberAdvertisedScopedMcpCatalog: vi.fn(
      (
        handle: { runtime: Runtime },
        catalog: typeof advertised extends Map<string, infer V> ? V : never,
      ) => {
        const existing = advertised.get(handle.runtime.sessionId);
        if (!existing) {
          advertised.set(handle.runtime.sessionId, catalog);
          return;
        }
        const updatedServers = new Set(Object.keys(catalog.servers));
        advertised.set(handle.runtime.sessionId, {
          version: catalog.version,
          generatedAt: catalog.generatedAt,
          servers: { ...existing.servers, ...catalog.servers },
          tools: [
            ...existing.tools.filter((tool) => !updatedServers.has(tool.serverName)),
            ...catalog.tools,
          ],
        });
      },
    ),
    getAdvertisedScopedMcpCatalog: vi.fn((sessionId: string) => advertised.get(sessionId) ?? null),
    reset() {
      advertised.clear();
      runtimes.clear();
      resolveImpl = undefined;
    },
  };
});

vi.mock("./agent-bundle-mcp-manager-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-bundle-mcp-manager-api.js")>();
  return {
    ...actual,
    acquireRequesterScopedMcpRuntime: mocks.acquireRequesterScopedMcpRuntime,
    acquireSessionMcpRuntime: mocks.acquireSessionMcpRuntime,
    rememberAdvertisedScopedMcpCatalog: mocks.rememberAdvertisedScopedMcpCatalog,
    getAdvertisedScopedMcpCatalog: mocks.getAdvertisedScopedMcpCatalog,
  };
});

vi.mock("./mcp-oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-oauth.js")>();
  return {
    ...actual,
    readMcpOAuthCredentialsStatus: readCredentialsStatus,
    startMcpOAuthAuthorization: startAuthorization,
  };
});

import {
  materializeRequesterScopedMcpToolsForHarnessRunCore,
  materializeStaticMcpToolsForHarnessRunCore,
} from "./agent-bundle-mcp-harness.js";
import { makeConnectRuntime, makeRuntime } from "./agent-bundle-mcp-harness.test-support.js";

beforeEach(() => {
  mocks.reset();
  mocks.acquireRequesterScopedMcpRuntime.mockClear();
  mocks.acquireSessionMcpRuntime.mockReset();
  mocks.rememberAdvertisedScopedMcpCatalog.mockClear();
  mocks.getAdvertisedScopedMcpCatalog.mockClear();
  readCredentialsStatus.mockReset().mockResolvedValue({ state: "unauthenticated" });
  startAuthorization.mockReset();
});

describe("materializeStaticMcpToolsForHarnessRunCore", () => {
  it("materializes static tools without carrying requester identity and applies the stored cap", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = "approve";
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
    });

    expect(mocks.acquireSessionMcpRuntime).toHaveBeenCalledWith(
      expect.not.objectContaining({
        requesterSenderId: expect.anything(),
        agentAccountId: expect.anything(),
        messageChannel: expect.anything(),
      }),
    );
    expect(result?.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    await result?.dispose();
  });

  it("never widens a finite scheduled cap", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-denied", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-denied",
      workspaceDir: "/workspace",
      toolsAllow: ["read"],
    });

    expect(result?.tools).toEqual([]);
    await result?.dispose();
  });

  it("gates interactive configured MCP before the original executor", async () => {
    const runtime = makeRuntime({ sessionId: "interactive", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });
    let active: (() => boolean) | undefined;
    const requestInteractiveCodexApproval = vi.fn(async (request) => {
      active = request.isActive;
      if (request.toolCallId === "denied") {
        throw new Error("operator denied");
      }
    });

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "interactive",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
      requestInteractiveCodexApproval,
    });
    const tool = result.tools[0]!;

    await expect(tool.execute("denied", { folder: "private" })).rejects.toThrow("operator denied");
    expect(callTool).not.toHaveBeenCalled();

    await expect(tool.execute("allowed", { folder: "team" })).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith("user-mail", "inbox", { folder: "team" });
    expect(requestInteractiveCodexApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        safeToolName: "user-mail__inbox",
        toolCallId: "allowed",
        serverName: "user-mail",
        toolName: "inbox",
        mode: "auto",
      }),
    );
    expect(active?.()).toBe(false);
    await result.dispose();
  });

  it.each([
    { name: "full permission", mode: undefined, grant: false, approvalCalls: 0 },
    { name: "explicit prompt", mode: "prompt" as const, grant: false, approvalCalls: 1 },
    { name: "durable grant", mode: "auto" as const, grant: true, approvalCalls: 0 },
  ])("preserves $name on the interactive surface", async ({ mode, grant, approvalCalls }) => {
    const runtime = makeRuntime({ sessionId: "interactive-policy", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = mode;
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });
    const requestInteractiveCodexApproval = vi.fn(async () => undefined);

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "interactive-policy",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
      autoApproveCodexAppServerApprovals: true,
      projectedMcpServers: grant
        ? { "user-mail": { tools: { inbox: { approval_mode: "approve" } } } }
        : undefined,
      requestInteractiveCodexApproval,
    });
    await expect(result.tools[0]!.execute("call", {})).resolves.toBeDefined();
    expect(requestInteractiveCodexApproval).toHaveBeenCalledTimes(approvalCalls);
    await result.dispose();
  });

  it("binds persistent app views to the same finite scheduled cap", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-app", requesterSenderId: "unused" });
    runtime.sessionKey = "agent:main:main";
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.toolCount = 2;
    catalog.servers["user-mail"]!.codexApprovalMode = "approve";
    catalog.tools = [
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "show",
        inputSchema: { type: "object" },
        fallbackDescription: "show",
        uiResourceUri: "ui://user-mail/app",
      },
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "app-only",
        inputSchema: { type: "object" },
        fallbackDescription: "app-only",
        uiVisibility: ["app"],
      },
    ];
    runtime.mcpAppsEnabled = true;
    runtime.readResource = async () => ({
      contents: [
        {
          uri: "ui://user-mail/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>mail</html>",
        },
      ],
    });
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-app",
      sessionKey: "agent:main:main",
      agentId: "main",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__show", "user-mail__app-only"],
    });
    const callResult = await result.tools[0]!.execute("call-app", {});
    const viewId = (callResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;

    const view = getMcpAppViewLease(viewId!, runtime)!;
    expect(view.allowedAppToolNames).toEqual(new Set(["app-only", "show"]));
    await expect(
      executeMcpAppOperation(
        { runtime, view },
        { method: "tools/call", params: { name: "app-only", arguments: {} } },
      ),
    ).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledTimes(2);
    await result.dispose();
  });

  it("excludes unsafe auto app tools while allowing read-only app calls", async () => {
    const runtime = makeRuntime({
      sessionId: "scheduled-app-approval",
      requesterSenderId: "unused",
    });
    runtime.sessionKey = "agent:main:main";
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.toolCount = 3;
    catalog.servers["user-mail"]!.codexApprovalMode = "auto";
    catalog.tools = [
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "show",
        inputSchema: { type: "object" },
        fallbackDescription: "show",
        uiResourceUri: "ui://user-mail/app",
        codexAnnotations: { readOnlyHint: true },
      },
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "safe-app",
        inputSchema: { type: "object" },
        fallbackDescription: "safe app",
        uiVisibility: ["app"],
        codexAnnotations: { readOnlyHint: true },
      },
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "unsafe-app",
        inputSchema: { type: "object" },
        fallbackDescription: "unsafe app",
        uiVisibility: ["app"],
      },
    ];
    runtime.mcpAppsEnabled = true;
    runtime.readResource = async () => ({
      contents: [
        {
          uri: "ui://user-mail/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>mail</html>",
        },
      ],
    });
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });
    const requestInteractiveCodexApproval = vi.fn(async () => undefined);

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-app-approval",
      sessionKey: "agent:main:main",
      agentId: "main",
      workspaceDir: "/workspace",
      toolsAllow: ["*"],
      requestInteractiveCodexApproval,
    });
    const callResult = await result.tools[0]!.execute("call-app", {});
    const viewId = (callResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;
    const view = getMcpAppViewLease(viewId!, runtime)!;
    expect(view.allowedAppToolNames).toEqual(new Set(["safe-app", "show"]));

    await expect(
      executeMcpAppOperation(
        { runtime, view },
        { method: "tools/call", params: { name: "unsafe-app", arguments: {} } },
      ),
    ).rejects.toThrow('MCP tool "unsafe-app" is not app-callable');
    expect(callTool).toHaveBeenCalledTimes(1);
    await expect(
      executeMcpAppOperation(
        { runtime, view },
        { method: "tools/call", params: { name: "safe-app", arguments: {} } },
      ),
    ).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(requestInteractiveCodexApproval).not.toHaveBeenCalled();
    await result.dispose();
  });

  it("allows unannotated app tools under host-confirmed full permission", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-app-yolo", requesterSenderId: "unused" });
    runtime.sessionKey = "agent:main:main";
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.toolCount = 2;
    catalog.tools = [
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "show",
        inputSchema: { type: "object" },
        fallbackDescription: "show",
        uiResourceUri: "ui://user-mail/app",
      },
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "prompt-app",
        inputSchema: { type: "object" },
        fallbackDescription: "prompt app",
        uiVisibility: ["app"],
      },
    ];
    runtime.mcpAppsEnabled = true;
    runtime.readResource = async () => ({
      contents: [
        {
          uri: "ui://user-mail/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>mail</html>",
        },
      ],
    });
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-app-yolo",
      sessionKey: "agent:main:main",
      agentId: "main",
      workspaceDir: "/workspace",
      toolsAllow: ["*"],
      autoApproveCodexAppServerApprovals: true,
    });
    const callResult = await result.tools[0]!.execute("call-app", {});
    const viewId = (callResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;
    expect(getMcpAppViewLease(viewId!, runtime)?.allowedAppToolNames).toEqual(
      new Set(["prompt-app", "show"]),
    );
    await result.dispose();
  });

  it("retains prepared static ownership when discovery returns no catalog entries", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-empty", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const emptyCatalog = { version: 1, generatedAt: 0, servers: {}, tools: [] };
    runtime.peekCatalog = () => emptyCatalog;
    runtime.getCatalog = async () => emptyCatalog;
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-empty",
      workspaceDir: "/workspace",
      toolsAllow: ["*"],
    });

    expect(result).toMatchObject({ tools: [] });
    await result?.dispose();
  });

  it("returns a bounded operator-visible notice for failed configured MCP discovery", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-diagnostic", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const failedCatalog = {
      version: 1,
      generatedAt: 0,
      servers: {},
      tools: [],
      diagnostics: [
        {
          serverName: "user-mail",
          safeServerName: "user-mail",
          launchSummary: "user-mail",
          message: "authentication required",
        },
      ],
    };
    runtime.peekCatalog = () => failedCatalog;
    runtime.getCatalog = async () => failedCatalog;
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-diagnostic",
      workspaceDir: "/workspace",
      toolsAllow: ["*"],
    });

    expect(result.diagnosticNotice).toContain("user-mail: authentication required");
    expect(result.diagnosticNotice).toContain("Do not claim MCP-backed work succeeded");
    await result.dispose();
  });

  it("does not report incomplete MCP for a policy note that removed no tool", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-group-note", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });
    const warnings: string[] = [];

    // Isolated heartbeat session key with a caller-provided Telegram group id: the final
    // policy pass drops the group id (and says so) but keeps every configured tool.
    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-group-note",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
      autoApproveCodexAppServerApprovals: true,
      policyContext: {
        config: { agents: { entries: { demo: {} } } },
        agentId: "demo",
        sessionKey: "agent:demo:main:heartbeat",
        groupId: "-1000000000001",
        messageProvider: "telegram",
        modelProvider: "openai",
      },
      warn: (message) => warnings.push(message),
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    expect(warnings).toContain(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
    expect(result.diagnosticNotice).toBeUndefined();
    await result.dispose();
  });

  it.each([undefined, "-1000000000001"])(
    "reports heartbeat policy omissions independently of group warnings (groupId: %s)",
    async (groupId) => {
      const runtime = makeRuntime({
        sessionId: "scheduled-group-deny",
        requesterSenderId: "unused",
      });
      delete runtime.requesterScope;
      mocks.acquireSessionMcpRuntime.mockResolvedValue({
        runtime,
        releaseLease: runtime.acquireLease?.() ?? (() => {}),
      });

      const result = await materializeStaticMcpToolsForHarnessRunCore({
        sessionId: "scheduled-group-deny",
        workspaceDir: "/workspace",
        toolsAllow: ["user-mail__inbox"],
        autoApproveCodexAppServerApprovals: true,
        policyContext: {
          config: {
            agents: { entries: { demo: {} } },
            tools: { deny: ["user-mail__inbox"] },
          },
          agentId: "demo",
          sessionKey: "agent:demo:main:heartbeat",
          groupId,
          messageProvider: "telegram",
          modelProvider: "openai",
        },
      });

      expect(result.tools).toEqual([]);
      expect(result.diagnosticNotice).toContain(
        "Configured MCP is incomplete for this scheduled run",
      );
      expect(result.diagnosticNotice).toContain("1 configured MCP tool(s) omitted by policy");
      expect(result.diagnosticNotice).not.toContain("dropping caller-provided groupId");
      await result.dispose();
    },
  );

  it("omits prompt-approved MCP tools from unattended execution", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-prompt", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.codexApprovalMode = "prompt";
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });
    const callTool = vi.spyOn(runtime, "callTool");

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-prompt",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
    });

    expect(result.tools).toEqual([]);
    expect(result.diagnosticNotice).toContain("user-mail/inbox");
    expect(result.diagnosticNotice).toContain(
      "openclaw mcp configure user-mail --approval approve",
    );
    expect(callTool).not.toHaveBeenCalled();
    await result?.dispose();
  });

  it.each([
    { mode: undefined, allowed: true },
    { mode: "auto" as const, allowed: false },
    { mode: "prompt" as const, allowed: false },
    { mode: "approve" as const, allowed: true },
  ])("honors explicit $mode in scheduled full-permission sessions", async ({ mode, allowed }) => {
    const runtime = makeRuntime({ sessionId: "scheduled-yolo", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = mode;
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });
    const callTool = vi.spyOn(runtime, "callTool");

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-yolo",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
      autoApproveCodexAppServerApprovals: true,
    });

    if (allowed) {
      await expect(result.tools[0]!.execute("call-1", {})).resolves.toBeDefined();
      expect(callTool).toHaveBeenCalledOnce();
    } else {
      expect(result.tools).toEqual([]);
      expect(result.diagnosticNotice).toContain("user-mail/inbox");
      expect(callTool).not.toHaveBeenCalled();
    }
    await result.dispose();
  });

  it.each([
    { mode: "approve" as const, annotations: undefined },
    { mode: "auto" as const, annotations: { readOnlyHint: true } },
  ])("executes scheduled MCP tools admitted by $mode approval", async ({ mode, annotations }) => {
    const runtime = makeRuntime({ sessionId: `scheduled-${mode}`, requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.codexApprovalMode = mode;
    if (annotations) {
      catalog.tools[0]!.codexAnnotations = annotations;
    }
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });
    const callTool = vi.spyOn(runtime, "callTool");

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: `scheduled-${mode}`,
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
    });

    await expect(result!.tools[0]!.execute("call-1", {})).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledOnce();
    await result?.dispose();
  });

  it("omits MCP tools when scheduled approval metadata is absent", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-unknown", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    mocks.acquireSessionMcpRuntime.mockResolvedValue({
      runtime,
      releaseLease: runtime.acquireLease?.() ?? (() => {}),
    });
    const callTool = vi.spyOn(runtime, "callTool");

    const result = await materializeStaticMcpToolsForHarnessRunCore({
      sessionId: "scheduled-unknown",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
    });

    expect(result.tools).toEqual([]);
    expect(result.diagnosticNotice).toContain("user-mail/inbox");
    expect(result.diagnosticNotice).toContain(
      "openclaw mcp configure user-mail --approval approve",
    );
    expect(callTool).not.toHaveBeenCalled();
    await result?.dispose();
  });
});

afterEach(() => {
  mocks.reset();
  mcpUiResourceTesting.clearViewStore();
});

describe("materializeRequesterScopedMcpToolsForHarnessRunCore", () => {
  it("returns undefined before any requester resolves", async () => {
    mocks.setResolveImpl(async () => undefined);
    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-empty",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
    });
    expect(result).toBeUndefined();
    expect(mocks.rememberAdvertisedScopedMcpCatalog).not.toHaveBeenCalled();
  });

  it("surfaces a bounded diagnostic when a background-safe resolver is unavailable", async () => {
    mocks.setResolveImpl(async (params) => {
      params.onResolverUnavailable?.({ serverName: "user-mail", reason: "unavailable" });
      return undefined;
    });

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-background-unavailable",
      sessionKey: "agent:main:session-background-unavailable",
      agentId: "main",
      workspaceDir: "/workspace",
      scheduledCodexApproval: { autoApprove: false },
    });

    expect(result).toMatchObject({ tools: [], advertisedTools: [] });
    expect(result?.diagnosticNotice).toContain("user-mail: background connection unavailable");
    expect(result?.diagnosticNotice).toContain("Do not claim MCP-backed work succeeded");
    await result?.dispose();
  });

  it("keeps successful background bindings honest when one server fails tool discovery", async () => {
    const runtime = makeRuntime({
      sessionId: "session-background-partial-discovery",
      requesterSenderId: "owner",
    });
    runtime.peekCatalog()!.diagnostics = [
      {
        serverName: "user-calendar",
        safeServerName: "user-calendar",
        launchSummary: "user-calendar",
        message: "tools/list failed",
      },
    ];
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = "approve";
    mocks.setResolveImpl(async () => runtime);

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-background-partial-discovery",
      sessionKey: "agent:main:session-background-partial-discovery",
      agentId: "main",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
      scheduledCodexApproval: { autoApprove: false },
    });

    expect(result?.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    expect(result?.diagnosticNotice).toContain("user-calendar: tools/list failed");
    expect(result?.diagnosticNotice).toContain("Do not claim MCP-backed work succeeded");
    await result?.dispose();
  });

  it("binds partial live resolver catalogs to stable advertised names by canonical identity", async () => {
    const first = makeRuntime({
      sessionId: "session-resolver-collision",
      requesterSenderId: "owner-a",
    });
    const firstCatalog = first.peekCatalog()!;
    firstCatalog.servers = {
      a: { serverName: "a", safeServerName: "a", launchSummary: "a", toolCount: 1 },
      a__b: {
        serverName: "a__b",
        safeServerName: "a__b",
        launchSummary: "a__b",
        toolCount: 1,
      },
    };
    firstCatalog.tools = [
      {
        serverName: "a",
        safeServerName: "a",
        toolName: "b__c",
        inputSchema: { type: "object" },
        fallbackDescription: "first collision owner",
      },
      {
        serverName: "a__b",
        safeServerName: "a__b",
        toolName: "c",
        inputSchema: { type: "object" },
        fallbackDescription: "second collision owner",
      },
    ];
    const second = makeRuntime({
      sessionId: "session-resolver-collision",
      requesterSenderId: "owner-b",
    });
    const secondCatalog = second.peekCatalog()!;
    secondCatalog.servers = { a__b: firstCatalog.servers.a__b! };
    secondCatalog.tools = [firstCatalog.tools[1]!];
    const secondCall = vi.fn(async (serverName: string, toolName: string) => ({
      content: [{ type: "text" as const, text: `live:${serverName}:${toolName}` }],
      isError: false,
    }));
    second.callTool = secondCall;
    let resolveCount = 0;
    mocks.setResolveImpl(async () => (resolveCount++ === 0 ? first : second));

    const initial = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-resolver-collision",
      workspaceDir: "/workspace",
      requesterSenderId: "owner-a",
    });
    expect(initial?.advertisedTools.map((tool) => tool.name)).toEqual(["a__b__c", "a__b__c-2"]);
    await initial?.dispose();

    const partial = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-resolver-collision",
      workspaceDir: "/workspace",
      requesterSenderId: "owner-b",
    });
    const firstOwner = partial?.tools.find((tool) => tool.name === "a__b__c");
    const secondOwner = partial?.tools.find((tool) => tool.name === "a__b__c-2");
    await expect(firstOwner?.execute("call-a", {})).resolves.toMatchObject({
      details: { status: "error", mcpServer: "a", mcpTool: "b__c" },
    });
    await expect(secondOwner?.execute("call-b", {})).resolves.toMatchObject({
      content: [{ text: "live:a__b:c" }],
    });
    expect(secondCall).toHaveBeenCalledOnce();
    expect(secondCall).toHaveBeenCalledWith("a__b", "c", {});
    await partial?.dispose();
  });

  it.each([
    { mode: "prompt" as const, annotations: undefined },
    {
      mode: "auto" as const,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ])(
    "omits requester MCP tools that require unattended $mode approval",
    async ({ mode, annotations }) => {
      const runtime = makeRuntime({
        sessionId: `session-background-${mode}`,
        requesterSenderId: "owner",
      });
      const catalog = runtime.peekCatalog()!;
      catalog.servers["user-mail"]!.codexApprovalMode = mode;
      if (annotations) {
        catalog.tools[0]!.codexAnnotations = annotations;
      }
      mocks.setResolveImpl(async () => runtime);
      const callTool = vi.spyOn(runtime, "callTool");

      const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
        sessionId: `session-background-${mode}`,
        sessionKey: `agent:main:session-background-${mode}`,
        agentId: "main",
        workspaceDir: "/workspace",
        toolsAllow: ["user-mail__inbox"],
        scheduledCodexApproval: { autoApprove: false },
      });

      expect(result?.tools).toEqual([]);
      expect(result?.advertisedTools).toEqual([]);
      expect(result?.diagnosticNotice).toContain("user-mail/inbox");
      expect(callTool).not.toHaveBeenCalled();
      await result?.dispose();
    },
  );

  it("reserves static generated names while materializing requester tools", async () => {
    const runtime = makeRuntime({
      sessionId: "session-cross-partition-collision",
      requesterSenderId: "owner",
    });
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.safeServerName = "a__b";
    catalog.tools[0]!.safeServerName = "a__b";
    catalog.tools[0]!.toolName = "c";
    mocks.setResolveImpl(async () => runtime);

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-cross-partition-collision",
      workspaceDir: "/workspace",
      requesterSenderId: "owner",
      reservedToolNames: ["a__b__c"],
    });

    expect(result?.tools.map((tool) => tool.name)).toEqual(["a__b__c-2"]);
    expect(result?.advertisedTools.map((tool) => tool.name)).toEqual(["a__b__c-2"]);
    await result?.dispose();
  });

  it("forwards the host-admitted run identity to requester-scoped resolution", async () => {
    mocks.setResolveImpl(async () => undefined);

    await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-host-admitted",
      sessionKey: "agent:main:external:conversation",
      agentId: "main",
      workspaceDir: "/workspace",
      requesterSenderId: "owner:own_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agentAccountId: "default",
      messageChannel: "arxi",
      chatType: "direct",
      conversationId: "telegram-chat:42",
      runtimeGeneration: "63",
      traceId: "1234567890abcdef1234567890abcdef",
    });

    expect(mocks.acquireRequesterScopedMcpRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:external:conversation",
        agentId: "main",
        requesterSenderId: "owner:own_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        agentAccountId: "default",
        messageChannel: "arxi",
        chatType: "direct",
        conversationId: "telegram-chat:42",
        runtimeGeneration: "63",
        traceId: "1234567890abcdef1234567890abcdef",
      }),
    );
  });

  it("bootstraps a requester connect tool without starting OAuth during materialization", async () => {
    mocks.setResolveImpl(async (params) =>
      makeConnectRuntime({
        sessionId: params.sessionId,
        requesterSenderId: params.requesterSenderId ?? "alice",
        publicOrigin: "https://gateway.example",
      }),
    );
    startAuthorization.mockResolvedValue({
      status: "redirect",
      authorizationUrl: "https://auth.example/authorize?state=opaque",
      redirectUrl: "https://gateway.example/oauth/mcp/callback",
      state: "opaque",
    });
    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-connect",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
      messageChannel: "telegram",
      agentAccountId: "bot",
      cfg: {
        gateway: { publicOrigin: "https://gateway.example" },
        mcp: {
          servers: {
            calendar: {
              url: "https://mcp.example/rpc",
              auth: "oauth",
              oauth: { identity: "per-requester" },
            },
          },
        },
      },
    });

    expect(result?.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
    expect(startAuthorization).not.toHaveBeenCalled();
    const connect = await result!.tools[0]!.execute("connect", {});
    expect(connect).toMatchObject({
      details: {
        mcpConnect: {
          serverName: "calendar",
          authorizationUrl: "https://auth.example/authorize?state=opaque",
        },
      },
    });
    expect(startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ principal: "requester", serverName: "calendar" }),
      expect.objectContaining({ url: "https://mcp.example/rpc" }),
      { redirectUrl: "https://gateway.example/oauth/mcp/callback" },
    );
    expect(mocks.rememberAdvertisedScopedMcpCatalog).toHaveBeenCalledOnce();
    await result!.dispose();
  });

  it("returns a bounded operator fix when the public origin is missing", async () => {
    mocks.setResolveImpl(async (params) =>
      makeConnectRuntime({
        sessionId: params.sessionId,
        requesterSenderId: params.requesterSenderId ?? "alice",
      }),
    );
    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-no-origin",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
      cfg: {
        mcp: {
          servers: {
            calendar: {
              url: "https://mcp.example/rpc",
              auth: "oauth",
              oauth: { identity: "per-requester" },
            },
          },
        },
      },
    });

    const connect = await result!.tools[0]!.execute("connect", {});
    expect(connect.details).toMatchObject({ status: "error" });
    expect(connect.content[0]).toMatchObject({ text: expect.stringContaining("publicOrigin") });
    expect(startAuthorization).not.toHaveBeenCalled();
    await result!.dispose();
  });

  it("releases the live runtime when pre-return catalog publication fails", async () => {
    const runtime = makeRuntime({ sessionId: "session-cleanup", requesterSenderId: "authed" });
    mocks.setResolveImpl(async () => runtime);
    mocks.rememberAdvertisedScopedMcpCatalog.mockImplementationOnce(() => {
      throw new Error("catalog publication failed");
    });

    await expect(
      materializeRequesterScopedMcpToolsForHarnessRunCore({
        sessionId: "session-cleanup",
        workspaceDir: "/workspace",
        requesterSenderId: "authed",
      }),
    ).rejects.toThrow("catalog publication failed");
    expect(runtime.activeLeases).toBe(0);
  });

  it("keeps advertised specs stable and returns not-connected for unauthed senders", async () => {
    mocks.setResolveImpl(async (params) => {
      const senderId = params.requesterSenderId;
      if (senderId !== "authed") {
        return undefined;
      }
      return makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: "authed",
      });
    });

    const authed = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-stable",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
      autoApproveCodexAppServerApprovals: true,
    });
    expect(authed).toBeDefined();
    const advertisedNames = authed!.advertisedTools.map((tool) => tool.name);
    expect(advertisedNames).toEqual(["user-mail__inbox"]);

    const live = await authed!.tools[0]!.execute("c1", {});
    expect(live.content[0]).toMatchObject({
      type: "text",
      text: "live:inbox:authed",
    });
    await authed!.dispose();

    const guest = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-stable",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
      autoApproveCodexAppServerApprovals: true,
    });
    expect(guest).toBeDefined();
    expect(guest!.advertisedTools.map((tool) => tool.name)).toEqual(advertisedNames);
    expect(guest!.tools.map((tool) => tool.name)).toEqual(advertisedNames);

    const notConnected = await guest!.tools[0]!.execute("c2", {});
    expect(notConnected.details).toMatchObject({ status: "error" });
    const text =
      notConnected.content[0] && "text" in notConnected.content[0]
        ? notConnected.content[0].text
        : "";
    expect(text).toMatch(/has not connected MCP server/i);
    await guest!.dispose();
  });

  it("removes direct-policy-denied tools from executable and advertised requester catalogs", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: params.requesterSenderId ?? "authed",
      }),
    );

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-policy",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
      autoApproveCodexAppServerApprovals: true,
      policyContext: {
        conversationToolPolicy: { deny: ["user-mail__inbox"] },
      },
    });

    expect(result).toBeDefined();
    expect(result!.tools).toEqual([]);
    expect(result!.advertisedTools).toEqual([]);
    await result!.dispose();
  });

  it("routes authed calls to that sender's runtime only", async () => {
    mocks.setResolveImpl(async (params) => {
      const senderId =
        typeof params.requesterSenderId === "string" ? params.requesterSenderId : undefined;
      if (!senderId) {
        return undefined;
      }
      return makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: senderId,
      });
    });

    const alice = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-route",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
      autoApproveCodexAppServerApprovals: true,
    });
    const bob = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-route",
      workspaceDir: "/workspace",
      requesterSenderId: "bob",
      autoApproveCodexAppServerApprovals: true,
    });
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice!.advertisedTools.map((t) => t.name)).toEqual(
      bob!.advertisedTools.map((t) => t.name),
    );

    const aliceResult = await alice!.tools[0]!.execute("a", {});
    const bobResult = await bob!.tools[0]!.execute("b", {});
    expect(aliceResult.content[0]).toMatchObject({ text: "live:inbox:alice" });
    expect(bobResult.content[0]).toMatchObject({ text: "live:inbox:bob" });

    await alice!.dispose();
    await bob!.dispose();
  });

  it("gates prompt-required requester MCP before the original executor", async () => {
    const runtime = makeRuntime({ sessionId: "session-gate", requesterSenderId: "authed" });
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = "prompt";
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.setResolveImpl(async () => runtime);
    const requestInteractiveCodexApproval = vi.fn(async (request) => {
      if (request.toolCallId === "denied") {
        throw new Error("operator denied");
      }
    });

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-gate",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
      requestInteractiveCodexApproval,
    });
    expect(result).toBeDefined();
    const tool = result!.tools[0]!;
    expect(tool.name).toBe("user-mail__inbox");

    await expect(tool.execute("denied", {})).rejects.toThrow("operator denied");
    expect(callTool).not.toHaveBeenCalled();

    await expect(tool.execute("allowed", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "live:inbox:authed" }],
    });
    expect(callTool).toHaveBeenCalledOnce();
    expect(requestInteractiveCodexApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        safeToolName: "user-mail__inbox",
        toolCallId: "allowed",
        serverName: "user-mail",
        toolName: "inbox",
        mode: "prompt",
      }),
    );
    expect(result!.advertisedTools.map((entry) => entry.name)).toEqual(["user-mail__inbox"]);
    await result!.dispose();
  });

  it("dispatches prompt-required requester tools ungated when no callback is available", async () => {
    const runtime = makeRuntime({ sessionId: "session-failopen", requesterSenderId: "authed" });
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = "prompt";
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.setResolveImpl(async () => runtime);

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-failopen",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
    });

    expect(result).toBeDefined();
    // Fail open by explicit caller-compatibility decision: callers that pass no
    // approval callback keep their pre-gate behavior — the tool stays exposed
    // and dispatches ungated, so a caller's tool surface never loses
    // availability across upgrades. OpenClaw's own requester turns always pass
    // an approval callback, so this branch is foreign-SDK-caller only.
    expect(result!.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    expect(result!.advertisedTools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);

    await expect(result!.tools[0]!.execute("ungated", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "live:inbox:authed" }],
    });
    expect(callTool).toHaveBeenCalledOnce();
    await result!.dispose();
  });

  it("exempts only trusted OAuth bootstrap tools, not real server tools named connect", async () => {
    const runtime = makeRuntime({
      sessionId: "session-connect-provenance",
      requesterSenderId: "authed",
    });
    const catalog = runtime.peekCatalog()!;
    // Real server capability named "connect" — must stay behind the approval gate.
    catalog.servers["drive"] = {
      serverName: "drive",
      launchSummary: "drive",
      toolCount: 1,
      codexApprovalMode: "prompt",
    };
    catalog.tools.push({
      serverName: "drive",
      safeServerName: "drive",
      toolName: "connect",
      description: "sync drive",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "sync drive",
    });
    // Trusted requester OAuth sign-in bootstrap — exempt by provenance, not by name.
    catalog.servers["auth-hub"] = {
      serverName: "auth-hub",
      launchSummary: "auth-hub",
      toolCount: 1,
      codexApprovalMode: "prompt",
    };
    catalog.tools.push({
      serverName: "auth-hub",
      safeServerName: "auth-hub",
      toolName: "connect",
      description: "Connect your auth-hub account.",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "Connect your auth-hub account.",
      oauthConnectBootstrap: true,
    });
    catalog.servers["user-mail"]!.codexApprovalMode = "prompt";
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.setResolveImpl(async () => runtime);

    // No callback: fail open by explicit caller-compatibility decision — all
    // tools stay exposed on both surfaces and dispatch ungated. The trusted
    // bootstrap exemption still matters when a callback IS provided (gated
    // below), where only the bootstrap reaches the server without approval.
    const failClosed = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-connect-provenance",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
    });
    expect(failClosed!.tools.map((tool) => tool.name)).toEqual([
      "auth-hub__connect",
      "drive__connect",
      "user-mail__inbox",
    ]);
    expect(failClosed!.advertisedTools.map((tool) => tool.name)).toEqual([
      "auth-hub__connect",
      "drive__connect",
      "user-mail__inbox",
    ]);
    await failClosed!.dispose();

    // With a callback: the real server capability named connect is gated like any
    // other prompt-required tool and only reaches the server after approval.
    const requestInteractiveCodexApproval = vi.fn(async (request) => {
      if (request.toolCallId === "denied-connect") {
        throw new Error("operator denied");
      }
    });
    const gated = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-connect-provenance",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
      requestInteractiveCodexApproval,
    });
    const realConnect = gated!.tools.find((tool) => tool.name === "drive__connect");
    expect(realConnect).toBeDefined();
    await expect(realConnect!.execute("denied-connect", {})).rejects.toThrow("operator denied");
    expect(callTool).not.toHaveBeenCalled();
    await expect(realConnect!.execute("allowed-connect", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "live:connect:authed" }],
    });
    expect(callTool).toHaveBeenCalledWith("drive", "connect", {});
    expect(requestInteractiveCodexApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({ serverName: "drive", toolName: "connect", mode: "prompt" }),
    );
    await gated!.dispose();
  });

  it("dispatches auto-mode requester tools under full-permission posture without approval", async () => {
    const runtime = makeRuntime({ sessionId: "session-yolo", requesterSenderId: "authed" });
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.setResolveImpl(async () => runtime);

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore({
      sessionId: "session-yolo",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
      autoApproveCodexAppServerApprovals: true,
    });

    expect(result!.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    expect(result!.advertisedTools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    await expect(result!.tools[0]!.execute("c1", {})).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledOnce();
    await result!.dispose();
  });
});
