import type { PreparedPairedComputerUse } from "../agents/computer-use-node-capabilities.js";
import { createOpenClawComputerTool } from "../agents/openclaw-tools.js";
import type { OpenClawToolsOptions } from "../agents/openclaw-tools.types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";

/**
 * Re-creates only the computer tool with a prepared paired-node action surface and returns
 * the same final tool list. Absent when policy replaced or removed the constructed computer,
 * so the caller falls back to a full build.
 */
export function createPairedComputerRebuild(params: {
  tools: readonly AnyAgentTool[];
  constructedComputer: AnyAgentTool | undefined;
  options: OpenClawToolsOptions;
  finalizeTools: (tools: AnyAgentTool[]) => AnyAgentTool[];
}): ((prepared: PreparedPairedComputerUse) => AnyAgentTool[] | undefined) | undefined {
  const { tools, constructedComputer, options, finalizeTools } = params;
  const index = constructedComputer ? tools.indexOf(constructedComputer) : -1;
  if (index < 0) {
    return undefined;
  }
  return (prepared) => {
    const computer = createOpenClawComputerTool({ ...options, pairedNodeComputerUse: prepared });
    return computer
      ? finalizeTools(tools.map((tool, at) => (at === index ? computer : tool)))
      : undefined;
  };
}
