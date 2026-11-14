import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

function resolve(managedNativeTools: unknown, agentId = "main") {
  return buildAnthropicCliBackend().resolveManagedNativeTools?.({
    config: { plugins: { entries: { anthropic: { config: { managedNativeTools } } } } },
    agentId,
  });
}

describe("Claude CLI managed native tools", () => {
  it("keeps nothing unless the operator selects tools", () => {
    expect(buildAnthropicCliBackend().resolveManagedNativeTools?.({ agentId: "main" })).toEqual([]);
    expect(resolve(undefined)).toEqual([]);
    expect(resolve({})).toEqual([]);
  });

  it("applies the default, replaced by an agent's own list", () => {
    const selection = { default: ["Workflow", "Agent"], agents: { research: ["Agent"], ops: [] } };
    // Canonical order keeps equivalent configs on one launch argv and cached prefix.
    expect(resolve(selection, "main")).toEqual(["Agent", "Workflow"]);
    expect(resolve(selection, "research")).toEqual(["Agent"]);
    expect(resolve(selection, "ops")).toEqual([]);
  });

  it("keeps file, shell and web tools by their projected capability, never scheduling", () => {
    const backend = buildAnthropicCliBackend();
    const selected = resolve({ default: ["Read", "Bash", "Agent", "Monitor", "CronCreate"] });
    expect(selected).toEqual(["Agent", "Bash", "Read"]);
    expect(backend.projectNativeToolAuthority?.(selected ?? [])).toEqual(["read", "exec"]);
    expect(backend.projectNativeToolAuthority?.(["Agent", "Workflow"])).toEqual([]);
  });

  it('"all" keeps every Claude Code tool a managed turn may hold', () => {
    const all = resolve({ default: "all", agents: { ops: ["Agent"] } });
    expect(all).toEqual([
      "Agent",
      "Workflow",
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
    ]);
    expect(resolve({ default: "all", agents: { ops: ["Agent"] } }, "ops")).toEqual(["Agent"]);
    expect(resolve({ agents: { ops: "all" } }, "ops")).toEqual(all);
  });

  it("runs every model call of the program on the turn's model when the operator asks", () => {
    const prepare = (turnModelOnly: unknown, modelId = "claude-opus-5-5") =>
      buildAnthropicCliBackend().prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId,
        config: { plugins: { entries: { anthropic: { config: { turnModelOnly } } } } },
      }) as { env: Record<string, string> };
    const pinned = prepare(true).env;
    expect(pinned.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe("1");
    expect(pinned.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe("1");
    for (const name of [
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
    ]) {
      expect(pinned[name]).toBe("claude-opus-5-5");
    }
    expect(Object.keys(prepare(undefined).env)).not.toContain("CLAUDE_CODE_SUBAGENT_MODEL");
    expect(Object.keys(prepare(true, "default").env)).not.toContain("CLAUDE_CODE_SUBAGENT_MODEL");
  });

  it("names only orchestration tools as delegation", () => {
    expect(buildAnthropicCliBackend().nativeDelegationTools).toEqual(["Agent", "Workflow"]);
  });

  it.each<[unknown, boolean]>([
    [{ default: ["Agent", "Workflow"], agents: { ops: [] } }, true],
    [{ default: "all", agents: { ops: ["Bash", "WebSearch"] } }, true],
    [{ agents: { ops: "all" } }, true],
    [{ default: ["Skill"] }, false],
    [{ agents: { ops: ["Monitor"] } }, false],
    [{ default: "everything" }, false],
    [{ default: ["Agent", "Agent"] }, false],
    [{ allow: ["Agent"] }, false],
  ])("validates managedNativeTools config %j", (managedNativeTools, expected) => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      value: { managedNativeTools },
    });
    expect(result.ok).toBe(expected);
  });
});
