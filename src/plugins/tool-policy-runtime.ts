import type { PluginRegistry } from "./registry-types.js";

/** Retain full-only tool boundaries in a matching prepared discovery generation. */
export function adoptRuntimeToolPolicyRegistrations(
  target: PluginRegistry,
  runtime: PluginRegistry,
): PluginRegistry {
  const matches = (pluginId: string) => {
    const owner = target.plugins.find((plugin) => plugin.id === pluginId);
    const active = runtime.plugins.find((plugin) => plugin.id === pluginId);
    return (
      owner?.status === "loaded" &&
      active?.status === "loaded" &&
      Boolean(owner.source) &&
      owner.source === active.source
    );
  };
  const hooks = runtime.typedHooks.filter(
    (hook) =>
      (hook.hookName === "before_tool_call" || hook.hookName === "after_tool_call") &&
      matches(hook.pluginId) &&
      !target.typedHooks.some(
        (candidate) => candidate.pluginId === hook.pluginId && candidate.hookName === hook.hookName,
      ),
  );
  const policies = runtime.trustedToolPolicies.filter(
    (entry) =>
      matches(entry.pluginId) &&
      !target.trustedToolPolicies.some(
        (candidate) =>
          candidate.pluginId === entry.pluginId && candidate.policy.id === entry.policy.id,
      ),
  );
  return hooks.length || policies.length
    ? {
        ...target,
        typedHooks: [...target.typedHooks, ...hooks],
        trustedToolPolicies: [...target.trustedToolPolicies, ...policies].toSorted(
          (a, b) => (a.origin === "bundled" ? 0 : 1) - (b.origin === "bundled" ? 0 : 1),
        ),
      }
    : target;
}
