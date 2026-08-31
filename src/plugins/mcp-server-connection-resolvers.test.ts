import { describe, expect, it } from "vitest";
import { adoptRuntimeMcpServerConnectionResolverRegistrations } from "./mcp-server-connection-resolvers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import type { OpenClawPluginMcpServerConnectionResolver } from "./types.js";

const resolver: OpenClawPluginMcpServerConnectionResolver = {
  serverName: "google_workspace",
  requiresRequesterIdentity: false,
  resolve: async () => ({ url: "http://127.0.0.1:18080/google/mcp" }),
};

function registryWithPlugin(pluginId: string, source: string) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: pluginId, source }));
  return registry;
}

describe("adoptRuntimeMcpServerConnectionResolverRegistrations", () => {
  it("copies a full-only resolver from the matching lifecycle owner", () => {
    const source = "/tmp/arxi/index.mjs";
    const target = registryWithPlugin("arxi", source);
    const runtime = registryWithPlugin("arxi", source);
    runtime.mcpServerConnectionResolvers.push({
      pluginId: "arxi",
      pluginName: "Arxi",
      resolver,
      source,
      rootDir: "/tmp/arxi",
    });

    const adopted = adoptRuntimeMcpServerConnectionResolverRegistrations(target, runtime);

    expect(adopted).not.toBe(target);
    expect(target.mcpServerConnectionResolvers).toEqual([]);
    expect(adopted.mcpServerConnectionResolvers).toEqual(runtime.mcpServerConnectionResolvers);
  });

  it("rejects a resolver from a different plugin source", () => {
    const target = registryWithPlugin("arxi", "/tmp/scoped/arxi.mjs");
    const runtime = registryWithPlugin("arxi", "/tmp/root/arxi.mjs");
    runtime.mcpServerConnectionResolvers.push({
      pluginId: "arxi",
      pluginName: "Arxi",
      resolver,
      source: "/tmp/root/arxi.mjs",
      rootDir: "/tmp/root",
    });

    expect(adoptRuntimeMcpServerConnectionResolverRegistrations(target, runtime)).toBe(target);
  });

  it("keeps an existing scoped resolver owner authoritative", () => {
    const source = "/tmp/arxi/index.mjs";
    const target = registryWithPlugin("arxi", source);
    const runtime = registryWithPlugin("arxi", source);
    const scopedResolver = { ...resolver, resolve: async () => undefined };
    target.mcpServerConnectionResolvers.push({
      pluginId: "arxi",
      pluginName: "Arxi",
      resolver: scopedResolver,
      source,
      rootDir: "/tmp/arxi",
    });
    runtime.mcpServerConnectionResolvers.push({
      pluginId: "arxi",
      pluginName: "Arxi",
      resolver,
      source,
      rootDir: "/tmp/arxi",
    });

    const adopted = adoptRuntimeMcpServerConnectionResolverRegistrations(target, runtime);

    expect(adopted).toBe(target);
    expect(adopted.mcpServerConnectionResolvers[0]?.resolver.resolve).toBe(scopedResolver.resolve);
  });
});
