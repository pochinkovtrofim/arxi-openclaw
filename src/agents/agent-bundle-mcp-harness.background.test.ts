import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

const mocks = vi.hoisted(() => {
  const advertised = new Map<string, McpToolCatalog>();
  let runtime: SessionMcpRuntime | undefined;
  return {
    advertised,
    setRuntime(value: SessionMcpRuntime) {
      runtime = value;
    },
    getOrCreateRequesterScopedMcpRuntime: vi.fn(async () =>
      runtime
        ? { runtime, advertisedCatalogConfigFingerprint: runtime.configFingerprint }
        : undefined,
    ),
    rememberAdvertisedScopedMcpCatalog: vi.fn(
      (handle: { runtime: SessionMcpRuntime }, catalog: McpToolCatalog) => {
        advertised.set(handle.runtime.sessionId, structuredClone(catalog));
      },
    ),
    reset() {
      advertised.clear();
      runtime = undefined;
    },
  };
});

vi.mock("./agent-bundle-mcp-manager-api.js", () => ({
  getOrCreateRequesterScopedMcpRuntime: mocks.getOrCreateRequesterScopedMcpRuntime,
  getOrCreateSessionMcpRuntime: vi.fn(),
  rememberAdvertisedScopedMcpCatalog: mocks.rememberAdvertisedScopedMcpCatalog,
  getAdvertisedScopedMcpCatalog: vi.fn(
    (sessionId: string) => mocks.advertised.get(sessionId) ?? null,
  ),
  completeDeferredSessionMcpRuntimeRetirement: vi.fn(async () => false),
  retireSessionMcpRuntime: vi.fn(),
}));

import { materializeRequesterScopedMcpToolsForHarnessRunCore } from "./agent-bundle-mcp-harness.js";

function makeRuntime(sessionId: string): SessionMcpRuntime {
  const catalog: McpToolCatalog = {
    version: 1,
    generatedAt: 0,
    servers: {
      "user-mail": {
        serverName: "user-mail",
        safeServerName: "user-mail",
        launchSummary: "user-mail",
        toolCount: 1,
      },
    },
    tools: [
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "inbox",
        inputSchema: { type: "object", properties: {} },
        fallbackDescription: "read inbox",
      },
    ],
  };
  return {
    sessionId,
    workspaceDir: "/workspace",
    configFingerprint: "background-fixture",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => undefined,
    peekCatalog: () => catalog,
    getCatalog: async () => catalog,
    callTool: async () => ({ content: [] }),
    dispose: async () => undefined,
  };
}

function scheduledParams(sessionId: string, toolsAllow: string[]) {
  return {
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    agentId: "main",
    workspaceDir: "/workspace",
    toolsAllow,
    scheduledCodexApproval: { autoApprove: false },
  };
}

beforeEach(() => {
  mocks.reset();
  mocks.getOrCreateRequesterScopedMcpRuntime.mockClear();
  mocks.rememberAdvertisedScopedMcpCatalog
    .mockReset()
    .mockImplementation((handle: { runtime: SessionMcpRuntime }, catalog: McpToolCatalog) => {
      mocks.advertised.set(handle.runtime.sessionId, structuredClone(catalog));
    });
});

describe("background requester-scoped MCP harness", () => {
  it("treats a successfully listed empty catalog as complete", async () => {
    const runtime = makeRuntime("background-empty");
    const emptyCatalog: McpToolCatalog = { version: 1, generatedAt: 0, servers: {}, tools: [] };
    runtime.peekCatalog = () => emptyCatalog;
    runtime.getCatalog = async () => emptyCatalog;
    mocks.setRuntime(runtime);

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore(
      scheduledParams(runtime.sessionId, []),
    );

    expect(result).toMatchObject({ tools: [], advertisedTools: [], allocatedToolNames: [] });
    expect(result?.diagnosticNotice).toBeUndefined();
    expect(mocks.rememberAdvertisedScopedMcpCatalog).toHaveBeenCalledOnce();
    await result?.dispose();
  });

  it("publishes and binds utilities from a resource-only catalog", async () => {
    const runtime = makeRuntime("background-resources");
    const resourceCatalog: McpToolCatalog = {
      version: 1,
      generatedAt: 0,
      servers: {
        "user-mail": {
          serverName: "user-mail",
          safeServerName: "user-mail",
          launchSummary: "user-mail",
          toolCount: 0,
          resources: {},
        },
      },
      tools: [],
    };
    runtime.peekCatalog = () => resourceCatalog;
    runtime.getCatalog = async () => resourceCatalog;
    runtime.listResources = async () => ({ resources: [] });
    mocks.setRuntime(runtime);

    const result = await materializeRequesterScopedMcpToolsForHarnessRunCore(
      scheduledParams(runtime.sessionId, [
        "user-mail__resources_list",
        "user-mail__resources_read",
      ]),
    );

    expect(result?.tools.map((tool) => tool.name)).toEqual([
      "user-mail__resources_list",
      "user-mail__resources_read",
    ]);
    await expect(result!.tools[0]!.execute("list", {})).resolves.toMatchObject({
      details: { mcpOperation: "resources_list" },
    });
    await result?.dispose();
  });

  it("re-evaluates live approval metadata before a cached tool can execute", async () => {
    const runtime = makeRuntime("background-approval-transition");
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.codexApprovalMode = "auto";
    catalog.tools[0]!.codexAnnotations = { readOnlyHint: true };
    mocks.setRuntime(runtime);
    const params = scheduledParams(runtime.sessionId, ["user-mail__inbox"]);

    const readOnly = await materializeRequesterScopedMcpToolsForHarnessRunCore(params);
    expect(readOnly?.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    await readOnly?.dispose();

    // Keep the old permissive advertisement while the live server changes.
    delete catalog.tools[0]!.codexAnnotations;
    mocks.rememberAdvertisedScopedMcpCatalog.mockImplementationOnce(() => undefined);
    const destructive = await materializeRequesterScopedMcpToolsForHarnessRunCore(params);

    expect(destructive?.tools).toEqual([]);
    expect(destructive?.advertisedTools).toEqual([]);
    expect(destructive?.diagnosticNotice).toContain("user-mail/inbox");
    await destructive?.dispose();
  });
});
