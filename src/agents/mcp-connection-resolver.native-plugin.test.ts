import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../plugins/loader.test-fixtures.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { shouldLoadRequesterScopedMcpHarnessRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import { loadCodexBundleMcpThreadConfigCore } from "./codex-mcp-config.js";
import { resolveRequesterScopedMcpConnections } from "./mcp-connection-resolver.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

it("keeps a native plugin MCP server requester-scoped when the plugin registers its resolver", async () => {
  useNoBundledPlugins();
  const workspaceDir = makePluginLoaderTempDir();
  const pluginDir = path.join(workspaceDir, "arxi");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.mjs");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "arxi-resolver-proof",
      configSchema: { type: "object", additionalProperties: false },
      mcpServers: {
        google_workspace: {
          transport: "streamable-http",
          url: "http://127.0.0.1:18080/google/mcp",
        },
      },
    }),
  );
  fs.writeFileSync(
    pluginFile,
    `export default {
      id: "arxi-resolver-proof",
      register(api) {
        api.registerMcpServerConnectionResolver({
          serverName: "google_workspace",
          requiresRequesterIdentity: false,
          resolve: async () => ({ url: "http://127.0.0.1:18080/google/mcp" }),
        });
      },
    };`,
  );
  const config: OpenClawConfig = {
    plugins: {
      enabled: true,
      allow: ["arxi-resolver-proof"],
      load: { paths: [pluginFile] },
      entries: { "arxi-resolver-proof": { enabled: true } },
    },
  };

  const runtimeRegistry = loadAndActivateRootPluginRegistry({
    workspaceDir,
    config,
    cache: false,
  });
  expect(runtimeRegistry.mcpServerConnectionResolvers).toHaveLength(1);

  const manifestRegistry = loadPluginManifestRegistryForPluginRegistry({
    workspaceDir,
    config,
    includeDisabled: true,
  });
  const threadConfig = loadCodexBundleMcpThreadConfigCore({
    workspaceDir,
    cfg: config,
    manifestRegistry,
  });
  expect(threadConfig.staticServerNames).toEqual([]);
  expect(threadConfig.requesterScopedServerNames).toEqual(["google_workspace"]);
  expect(threadConfig.configPatch).toBeUndefined();
  expect(
    shouldLoadRequesterScopedMcpHarnessRuntime({
      sessionId: "session-1",
      agentId: "main",
      sessionKey: "agent:main:main",
    }),
  ).toBe(true);
  await expect(
    resolveRequesterScopedMcpConnections({
      serverNames: ["google_workspace"],
      agentId: "main",
      sessionKey: "agent:main:main",
    }),
  ).resolves.toEqual(new Map([["google_workspace", { url: "http://127.0.0.1:18080/google/mcp" }]]));

  const attemptRegistry = loadAgentRuntimePluginRegistryHandle({
    config,
    workspaceDir,
  });
  expect(attemptRegistry.mcpServerConnectionResolvers).toHaveLength(1);
  await expect(
    withPluginRuntimeRegistryScope(attemptRegistry, () =>
      resolveRequesterScopedMcpConnections({
        serverNames: ["google_workspace"],
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ),
  ).resolves.toEqual(new Map([["google_workspace", { url: "http://127.0.0.1:18080/google/mcp" }]]));
});

it("does not borrow a full-runtime MCP resolver into a discovery generation", async () => {
  useNoBundledPlugins();
  const workspaceDir = makePluginLoaderTempDir();
  const pluginDir = path.join(workspaceDir, "full-only-resolver");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.mjs");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "full-only-resolver",
      configSchema: { type: "object", additionalProperties: false },
      mcpServers: {
        google_workspace: {
          transport: "streamable-http",
          url: "http://127.0.0.1:18080/google/mcp",
        },
      },
    }),
  );
  fs.writeFileSync(
    pluginFile,
    `export default {
      id: "full-only-resolver",
      register(api) {
        if (api.registrationMode !== "full") return;
        api.registerMcpServerConnectionResolver({
          serverName: "google_workspace",
          requiresRequesterIdentity: false,
          resolve: async () => ({ url: "http://127.0.0.1:18080/google/mcp" }),
        });
      },
    };`,
  );
  const config: OpenClawConfig = {
    plugins: {
      enabled: true,
      allow: ["full-only-resolver"],
      load: { paths: [pluginFile] },
      entries: { "full-only-resolver": { enabled: true } },
    },
  };

  const runtimeRegistry = loadAndActivateRootPluginRegistry({
    workspaceDir,
    config,
    cache: false,
  });
  expect(runtimeRegistry.mcpServerConnectionResolvers).toHaveLength(1);

  const attemptRegistry = loadAgentRuntimePluginRegistryHandle({
    config,
    workspaceDir,
  });
  expect(attemptRegistry.mcpServerConnectionResolvers).toHaveLength(0);
  await expect(
    withPluginRuntimeRegistryScope(attemptRegistry, () =>
      resolveRequesterScopedMcpConnections({
        serverNames: ["google_workspace"],
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ),
  ).resolves.toEqual(new Map());
});
