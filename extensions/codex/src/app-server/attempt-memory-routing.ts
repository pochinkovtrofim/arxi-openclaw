import type { EmbeddedContextFile } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildMemorySystemPromptAddition,
  prepareMemorySystemPromptAddition,
} from "openclaw/plugin-sdk/core";
import type { CodexDynamicToolSpec } from "./protocol.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";

const CODEX_MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);

/**
 * Renders a memory-file reference that points Codex at memory tools instead of
 * embedding MEMORY.md contents.
 */
function renderCodexWorkspaceMemoryReference(params: {
  files: EmbeddedContextFile[];
  toolNames?: readonly string[];
}): string | undefined {
  if (params.files.length === 0) {
    return undefined;
  }
  const toolNames = params.toolNames?.length
    ? params.toolNames
    : Array.from(CODEX_MEMORY_TOOL_NAMES);
  const lines = [
    "## OpenClaw Workspace Memory",
    "",
    `MEMORY.md exists in the active agent workspace as a memory file, not an instruction file. OpenClaw does not paste its contents into native Codex turns; use ${toolNames.join(" or ")} when durable memory is relevant and the tools are available.`,
    "",
  ];
  for (const file of params.files) {
    lines.push(`- ${file.path}`);
  }
  return lines.join("\n").trim();
}

export async function renderCodexWorkspaceMemoryCollaborationInstructions(params: {
  files: EmbeddedContextFile[];
  toolNames: readonly string[];
  memoryToolRouted: boolean;
  citationsMode?: Parameters<typeof buildMemorySystemPromptAddition>[0]["citationsMode"];
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): Promise<string | undefined> {
  const memoryRecallInstructions = params.memoryToolRouted
    ? await renderCodexMemoryRecallInstructions({
        toolNames: params.toolNames,
        citationsMode: params.citationsMode,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
        sandboxed: params.sandboxed,
      })
    : undefined;
  const memoryReferenceInstructions = renderCodexWorkspaceMemoryReference({
    files: params.files,
    toolNames: params.toolNames,
  });
  const sections = [memoryRecallInstructions, memoryReferenceInstructions].filter(isNonEmptyString);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

async function renderCodexMemoryRecallInstructions(params: {
  toolNames: readonly string[];
  citationsMode?: Parameters<typeof buildMemorySystemPromptAddition>[0]["citationsMode"];
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): Promise<string | undefined> {
  const availableTools = new Set(params.toolNames);
  const memoryPrompt = await prepareMemorySystemPromptAddition({
    availableTools,
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
  });
  if (!memoryPrompt) {
    // Memory recall policy belongs to the active memory plugin.
    // Codex-side fallback text can mask plugin lifecycle bugs or misdescribe third-party memory tools.
    return undefined;
  }
  const toolSearchBridge = renderCodexMemoryToolSearchBridge(params.toolNames);
  return [memoryPrompt, toolSearchBridge].filter(isNonEmptyString).join("\n").trim();
}

function renderCodexMemoryToolSearchBridge(toolNames: readonly string[]): string | undefined {
  const memoryToolNames = toolNames
    .map((name) => normalizeCodexDynamicToolName(name))
    .filter((name) => CODEX_MEMORY_TOOL_NAMES.has(name))
    .toSorted();
  if (memoryToolNames.length === 0) {
    return undefined;
  }
  return `Codex may expose ${memoryToolNames.join(" and ")} as deferred tools. When the memory guidance above calls for memory recall, use an already-loaded memory tool directly. If the needed memory tool is deferred and not currently callable, use \`tool_search\` to load it, then call that memory tool.`;
}

/** Lists available memory tool names understood by Codex workspace memory routing. */
export function getCodexWorkspaceMemoryToolNames(tools: readonly CodexDynamicToolSpec[]): string[] {
  const availableToolNames = new Set(
    flattenCodexDynamicToolFunctions(tools).map((tool) => normalizeCodexDynamicToolName(tool.name)),
  );
  return Array.from(CODEX_MEMORY_TOOL_NAMES).filter((name) => availableToolNames.has(name));
}

function normalizeCodexDynamicToolName(name: string): string {
  return name.trim().toLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
