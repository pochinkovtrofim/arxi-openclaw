import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { attachToolAllowlistIntersection } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";

describe("codex MCP projection", () => {
  it("does not expose scheduled authority minting", async () => {
    const projection = await import("./codex-mcp-projection.js");

    expect(projection).not.toHaveProperty("bindCronScheduledTool");
  });

  it("recognizes only exact finite effective scheduled caps", async () => {
    const projection = await import("./codex-mcp-projection.js");
    expect(projection.hasExplicitFiniteCodexToolAllowlist(undefined)).toBe(false);
    expect(projection.hasExplicitFiniteCodexToolAllowlist(["*"])).toBe(false);
    expect(projection.hasExplicitFiniteCodexToolAllowlist(["read", "*"])).toBe(false);
    expect(projection.hasExplicitFiniteCodexToolAllowlist(["group:plugins"])).toBe(false);
    expect(projection.hasExplicitFiniteCodexToolAllowlist(["bundle-mcp"])).toBe(false);
    expect(projection.hasExplicitFiniteCodexToolAllowlist(["google_*_read"])).toBe(false);
    expect(projection.hasExplicitFiniteCodexToolAllowlist([])).toBe(true);
    expect(projection.hasExplicitFiniteCodexToolAllowlist(["read", "mail__search"])).toBe(true);

    const intersected = attachToolAllowlistIntersection(
      ["*", "mail__search"],
      [["*"], ["mail__search"]],
    );
    expect(projection.hasExplicitFiniteCodexToolAllowlist(intersected)).toBe(true);
  });

  it("withholds static MCP across both resolver availability transitions", async () => {
    const { shouldWithholdStaticCodexMcp } = await import("./codex-mcp-projection.js");
    const evaluate = (resolverDiagnosticNotice?: string) =>
      shouldWithholdStaticCodexMcp({
        scheduledAccountMcp: true,
        hasRequesterScopedMcp: true,
        toolsAllow: ["a__b__c"],
        resolverDiagnosticNotice,
      });

    expect([evaluate("unavailable"), evaluate(), evaluate("unavailable")]).toEqual([
      true,
      false,
      true,
    ]);
    expect(
      shouldWithholdStaticCodexMcp({
        scheduledAccountMcp: true,
        hasRequesterScopedMcp: true,
        toolsAllow: ["*"],
      }),
    ).toBe(true);
  });

  it("binds scheduled names to canonical MCP identities across disappearance and suffix shifts", async () => {
    const { resolveScheduledCodexMcpIdentityBindings } = await import("./codex-mcp-projection.js");
    const bindings = [
      { name: "mail__read", serverName: "resolver", operation: "tool" as const, toolName: "read" },
      {
        name: "mail__read-2",
        serverName: "static",
        operation: "tool" as const,
        toolName: "read",
      },
    ];
    const exact = resolveScheduledCodexMcpIdentityBindings({
      bindings,
      allocations: [
        { name: "mail__read", identity: '["resolver","tool","read"]' },
        { name: "mail__read-2", identity: '["static","tool","read"]' },
      ],
      exposedNames: ["mail__read", "mail__read-2"],
    });
    expect([...exact.allowedNames]).toEqual(["mail__read", "mail__read-2"]);
    expect(exact.rejectedNames).toEqual([]);

    const shifted = resolveScheduledCodexMcpIdentityBindings({
      bindings,
      allocations: [{ name: "mail__read", identity: '["static","tool","read"]' }],
      exposedNames: ["mail__read"],
    });
    expect([...shifted.allowedNames]).toEqual([]);
    expect(shifted.rejectedNames).toEqual(["mail__read", "mail__read-2"]);

    const suffixChain = resolveScheduledCodexMcpIdentityBindings({
      bindings: [
        {
          name: "mail__read-2",
          serverName: "resolver",
          operation: "tool",
          toolName: "read",
        },
      ],
      allocations: [{ name: "mail__read-2", identity: '["static","tool","read-2"]' }],
      exposedNames: ["mail__read-2"],
    });
    expect([...suffixChain.allowedNames]).toEqual([]);
    expect(suffixChain.rejectedNames).toEqual(["mail__read-2"]);
  });

  it("withholds legacy scheduled MCP names that have no canonical binding", async () => {
    const { resolveScheduledCodexMcpIdentityBindings } = await import("./codex-mcp-projection.js");
    const result = resolveScheduledCodexMcpIdentityBindings({
      bindings: undefined,
      allocations: [{ name: "mail__read", identity: '["mail","tool","read"]' }],
      exposedNames: ["mail__read"],
      persistedCapNames: ["mail__read", "read"],
    });

    expect([...result.allowedNames]).toEqual([]);
    expect(result.rejectedNames).toEqual(["mail__read"]);
  });

  it("does not capture a colliding plugin-created gateway exec tool", async () => {
    const projection = await import("./codex-mcp-projection.js");
    const tools: Array<string | { name: string; pluginId?: string }> = [];
    const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};
    const collidingTool = {
      name: "gateway_exec",
      label: "Plugin gateway exec",
      description: "A plugin-created tool with the same name as the Codex alias.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    } satisfies AnyAgentTool;

    const authority = await projection.captureFinalCodexCronCreatorToolAllowlist(
      tools,
      captureRef,
      [collidingTool],
    );

    expect(tools).toEqual([{ name: "gateway_exec" }]);
    expect(captureRef.value).toEqual({ version: 1, source: "final-executable-surface" });
    expect(authority).toBeUndefined();
  });
});
