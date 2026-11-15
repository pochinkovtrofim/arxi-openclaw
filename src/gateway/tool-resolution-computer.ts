import { applyToolAvailabilityDescriptions } from "../agents/agent-tools.deferred-followup.js";
import type { PreparedPairedComputerUse } from "../agents/computer-use-node-capabilities.js";
import { rebuildOpenClawComputerTool } from "../agents/openclaw-tools.assembly.js";
import { filterRequesterYieldTools } from "../agents/openclaw-tools.requester-yield.js";
import type { AnyAgentTool } from "../agents/tools/common.js";

/** Final catalog steps shared by a full build and a computer-only rebuild. */
export function finalizeScopedTools(
  tools: AnyAgentTool[],
  sessionKey: string | undefined,
): AnyAgentTool[] {
  return applyToolAvailabilityDescriptions(filterRequesterYieldTools(tools, sessionKey));
}

/**
 * Re-creates only the computer tool, through the same assembly as the full build that made
 * it, and returns the same final tool list. Absent when policy replaced or removed the built
 * computer, so the caller falls back to a full build.
 */
export function createPairedComputerRebuild(params: {
  tools: readonly AnyAgentTool[];
  builtComputer: AnyAgentTool | undefined;
  finalizeTools: (tools: AnyAgentTool[]) => AnyAgentTool[];
}): ((prepared: PreparedPairedComputerUse) => AnyAgentTool[] | undefined) | undefined {
  const { tools, builtComputer, finalizeTools } = params;
  const index = builtComputer ? tools.indexOf(builtComputer) : -1;
  if (!builtComputer || index < 0) {
    return undefined;
  }
  return (prepared) => {
    const computer = rebuildOpenClawComputerTool(builtComputer, prepared);
    return computer
      ? finalizeTools(tools.map((tool, at) => (at === index ? computer : tool)))
      : undefined;
  };
}
