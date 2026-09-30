import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AgentTool } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Erase a schema-specific session tool only after its input passes that owned schema. */
export function eraseSessionFileTool<TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      if (!Value.Check(tool.parameters, params)) {
        throw new Error(`Invalid parameters for ${tool.name}`);
      }
      // SAFETY: Value.Check above validated these parameters against this exact owning schema.
      const typedParams = params as Static<TParameters>;
      return await tool.execute(
        toolCallId,
        typedParams,
        signal,
        onUpdate ? (update) => onUpdate(update) : undefined,
      );
    },
  };
}
