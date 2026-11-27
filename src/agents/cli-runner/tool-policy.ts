import type { ResolvedCliBackend } from "../cli-backends.js";
import { formatToolNotAllowedInAutomation } from "../scheduled-tool-policy.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

/** Transport prefix CLI harnesses use for loopback OpenClaw MCP tool names. */
const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";
const GEMINI_OPENCLAW_MCP_TOOL_PREFIX = "mcp_openclaw_";

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripOpenClawMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(OPENCLAW_MCP_TOOL_PREFIX)
    ? toolName.slice(OPENCLAW_MCP_TOOL_PREFIX.length)
    : toolName.startsWith(GEMINI_OPENCLAW_MCP_TOOL_PREFIX)
      ? toolName.slice(GEMINI_OPENCLAW_MCP_TOOL_PREFIX.length)
      : toolName;
}

/** Match provider-native names against the canonical tool hook and policy ids. */
export function normalizeCliToolName(toolName: string): string {
  return normalizeToolPolicyName(
    toolName.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
  );
}

/** Keeps only explicit runtime caps for backend-owned exact translation. */
export function resolveCliRuntimeToolsAllow(toolsAllow?: string[]): string[] | undefined {
  if (toolsAllow === undefined) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
    ? undefined
    : toolsAllow;
}

/**
 * A run listing its uncapped surface calls only its scheduled cap's tools plus the
 * backend's capability-free natives; returns the model-readable refusal otherwise.
 */
export function refuseOutsideExecutionCap(
  run: Pick<RunCliAgentParams, "executionToolsAllow" | "cliToolAvailability">,
  backend: Pick<ResolvedCliBackend, "capabilityFreeNativeTools">,
  toolName: string,
): string | undefined {
  if (run.executionToolsAllow === undefined) {
    return undefined;
  }
  const openClawToolName = stripOpenClawMcpToolPrefix(toolName);
  const callable =
    openClawToolName !== toolName
      ? run.cliToolAvailability?.openClaw.includes(openClawToolName)
      : backend.capabilityFreeNativeTools?.includes(toolName) &&
        run.cliToolAvailability?.native.includes(toolName);
  return callable ? undefined : formatToolNotAllowedInAutomation(openClawToolName);
}
