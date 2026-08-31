import type { PluginRegistry } from "./registry-types.js";
import type { PluginMcpServerConnectionResolverRegistration } from "./types.mcp-connection.js";

function hasMatchingLoadedOwner(
  registration: PluginMcpServerConnectionResolverRegistration,
  targetRegistry: PluginRegistry,
  runtimeRegistry: PluginRegistry,
): boolean {
  const target = targetRegistry.plugins.find((plugin) => plugin.id === registration.pluginId);
  const runtime = runtimeRegistry.plugins.find((plugin) => plugin.id === registration.pluginId);
  return (
    target?.status === "loaded" &&
    runtime?.status === "loaded" &&
    target.source === runtime.source &&
    registration.source === runtime.source
  );
}

/**
 * Copies full-only MCP connection resolvers into a matching discovery registry
 * without re-running plugin code. Resolver ownership is an authorization
 * boundary, so an existing scoped owner always wins and sources must match.
 */
export function adoptRuntimeMcpServerConnectionResolverRegistrations(
  targetRegistry: PluginRegistry,
  runtimeRegistry: PluginRegistry,
): PluginRegistry {
  const resolvers = [...targetRegistry.mcpServerConnectionResolvers];
  let changed = false;
  for (const registration of runtimeRegistry.mcpServerConnectionResolvers) {
    if (!hasMatchingLoadedOwner(registration, targetRegistry, runtimeRegistry)) {
      continue;
    }
    if (
      resolvers.some(
        (candidate) => candidate.resolver.serverName === registration.resolver.serverName,
      )
    ) {
      continue;
    }
    resolvers.push(registration);
    changed = true;
  }
  return changed ? { ...targetRegistry, mcpServerConnectionResolvers: resolvers } : targetRegistry;
}
