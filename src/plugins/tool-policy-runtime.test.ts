import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { adoptRuntimeToolPolicyRegistrations } from "./tool-policy-runtime.js";

function fixture() {
  const runtime = createEmptyPluginRegistry();
  const target = createEmptyPluginRegistry();
  const owner = createPluginRecord({
    id: "approval",
    status: "loaded",
    source: "/plugins/approval/index.js",
  });
  runtime.plugins.push(owner);
  target.plugins.push({ ...owner });
  const handler = vi.fn(async () => ({ block: true, blockReason: "owner approval required" }));
  runtime.typedHooks.push({ pluginId: owner.id, hookName: "before_tool_call", handler });
  runtime.trustedToolPolicies.push({
    pluginId: owner.id,
    pluginName: "Approval",
    source: owner.source,
    origin: "bundled",
    policy: { id: "boundary", description: "boundary", evaluate: () => undefined },
  });
  return { runtime, target, handler };
}

describe("prepared runtime tool policy adoption", () => {
  it("keeps a full-only blocking hook in the discovery generation without mutating it", async () => {
    const { runtime, target, handler } = fixture();
    const adopted = adoptRuntimeToolPolicyRegistrations(target, runtime);
    const result = await createHookRunner(adopted).runBeforeToolCall(
      { toolName: "mail__send", params: {} },
      { toolName: "mail__send" },
    );
    expect(result).toMatchObject({ block: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(adopted.trustedToolPolicies).toEqual(runtime.trustedToolPolicies);
    expect(target.typedHooks).toEqual([]);
    expect(target.trustedToolPolicies).toEqual([]);
    expect(adoptRuntimeToolPolicyRegistrations(adopted, runtime)).toBe(adopted);
  });
  it.each(["disabled", "error", "missing", "shadow"])(
    "does not import authority for a %s owner",
    (reason) => {
      const { runtime, target } = fixture();
      if (reason === "missing") target.plugins = [];
      else if (reason === "shadow") target.plugins[0]!.source = "/workspace/shadow/index.js";
      else target.plugins[0]!.status = reason as "disabled" | "error";
      expect(adoptRuntimeToolPolicyRegistrations(target, runtime)).toBe(target);
    },
  );
  it("preserves a generation's own hook and does not start unrelated lifecycle hooks", async () => {
    const { runtime, target } = fixture();
    const own = vi.fn(async () => ({ block: true, blockReason: "current policy" }));
    target.typedHooks.push({ pluginId: "approval", hookName: "before_tool_call", handler: own });
    runtime.typedHooks.push({ pluginId: "approval", hookName: "gateway_start", handler: vi.fn() });
    const adopted = adoptRuntimeToolPolicyRegistrations(target, runtime);
    expect(adopted.typedHooks).toEqual(target.typedHooks);
    expect(
      await createHookRunner(adopted).runBeforeToolCall(
        { toolName: "send", params: {} },
        { toolName: "send" },
      ),
    ).toMatchObject({ blockReason: "current policy" });
  });
});
