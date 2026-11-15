import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { bindAssembledAgentToolActionDescriptor } from "./agent-tool-metadata.js";
import {
  type HookContext,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import type { PreparedPairedComputerUse } from "./computer-use-node-capabilities.js";
import { filterToolsByClientCaps } from "./openclaw-tools.client-caps.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createGatewayToolCallerWrapper } from "./tools/gateway-caller-context.js";

// A built computer tool remembers how to be re-created with a prepared paired-node surface,
// through the same captured options and assembly steps as the full build that made it.
const computerToolRebuilders = new WeakMap<
  AnyAgentTool,
  (prepared: PreparedPairedComputerUse) => AnyAgentTool | undefined
>();

/** Re-creates a built computer tool exactly as a full build would, for a prepared surface. */
export function rebuildOpenClawComputerTool(
  built: AnyAgentTool,
  prepared: PreparedPairedComputerUse,
): AnyAgentTool | undefined {
  return computerToolRebuilders.get(built)?.(prepared);
}

/**
 * The assembly every OpenClaw tool passes after construction: client capabilities,
 * availability, action descriptor, before-tool-call hook and gateway caller identity.
 * The computer tool reuses it, with the same options, when it is re-created alone.
 */
export function createOpenClawToolAssembly(params: {
  options: OpenClawToolsOptions | undefined;
  hookAgentId: string | undefined;
  gatewayCallerAccountId: string | undefined;
  resolvedConfig: OpenClawToolsOptions["config"];
  createComputerTool: (options?: OpenClawToolsOptions) => AnyAgentTool | null;
}) {
  const { options, hookAgentId, resolvedConfig } = params;
  const assemble = (candidates: AnyAgentTool[]) => {
    const assembled = finalizeAgentToolAvailability(
      filterToolsByClientCaps(candidates, options?.clientCaps),
    );
    for (const tool of assembled) {
      bindAssembledAgentToolActionDescriptor(tool);
    }
    return assembled;
  };
  const wrapGatewayCallerIdentity = createGatewayToolCallerWrapper(
    hookAgentId,
    options ? { ...options, agentAccountId: params.gatewayCallerAccountId } : options,
  );
  const defaultHookContext: HookContext = {
    ...(hookAgentId ? { agentId: hookAgentId } : {}),
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.currentChannelId ? { channelId: options.currentChannelId } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: resolvedConfig, agentId: hookAgentId }),
  };
  const hookContext = { ...defaultHookContext, ...options?.beforeToolCallHookContext };
  const wrap = (assembled: AnyAgentTool[]) =>
    options?.wrapBeforeToolCallHook === false
      ? assembled.map(wrapGatewayCallerIdentity)
      : assembled
          .map((tool) =>
            isToolWrappedWithBeforeToolCallHook(tool)
              ? tool
              : wrapToolWithBeforeToolCallHook(tool, hookContext),
          )
          .map(wrapGatewayCallerIdentity);
  /** Wraps the assembled list and lets its computer tool be re-created later. */
  const finish = (assembled: AnyAgentTool[], computerTool: AnyAgentTool | null) => {
    const wrapped = wrap(assembled);
    const builtComputer = wrapped[computerTool ? assembled.indexOf(computerTool) : -1];
    if (builtComputer) {
      computerToolRebuilders.set(builtComputer, (prepared) => {
        const rebuilt = params.createComputerTool({ ...options, pairedNodeComputerUse: prepared });
        // Availability finalization sees computer alone here, which is exact only because
        // computer has no availability binding (pinned by tool-resolution.computer-rebuild.test.ts).
        return rebuilt ? wrap(assemble([rebuilt]))[0] : undefined;
      });
    }
    return wrapped;
  };
  return { assemble, finish };
}
