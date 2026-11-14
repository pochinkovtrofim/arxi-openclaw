import { getActiveDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import type { HookContext } from "../agent-tools.before-tool-call.types.js";
import type { RunCliAgentParams } from "./types.js";

export function buildCliPromptBuildHookContext(
  params: RunCliAgentParams,
  prepared: { agentId: string; workspaceDir: string; modelId: string },
): PluginHookAgentContext {
  return {
    runId: params.runId,
    // Reuses the host-owned run trace. A new trace here would break source proofs.
    ...buildCliRunOrigin(params),
    agentId: prepared.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: prepared.workspaceDir,
    modelProviderId: params.provider,
    modelId: prepared.modelId,
    trigger: params.trigger,
    ...(params.trigger === "user" && params.senderId && params.chatId
      ? {
          requester: {
            senderId: params.senderId,
            conversationId: params.chatId,
            ...(params.chatType ? { chatType: params.chatType } : {}),
            ...(params.messageChannel ? { channel: params.messageChannel } : {}),
            ...(params.agentAccountId ? { accountId: params.agentAccountId } : {}),
            ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
          },
        }
      : {}),
    ...buildAgentHookContextChannelFields(params),
  };
}

/** The run's trace and the origin of its input, as embedded runs give them to tools. */
export type CliRunOrigin = Pick<HookContext, "trace" | "inputProvenance">;

/**
 * Prompt hooks and the tool calls the program makes over the loopback MCP
 * server both take the run's origin from here, so a tool that checks it (a
 * permission proof by trace, a steward-only tool by input origin) sees what
 * the prompt hooks saw. Reads the active run trace: call it in the run's scope.
 */
export function buildCliRunOrigin(params: RunCliAgentParams): CliRunOrigin {
  const trace = getActiveDiagnosticTraceContext();
  return {
    ...(trace ? { trace } : {}),
    ...(params.inputProvenance ? { inputProvenance: params.inputProvenance } : {}),
  };
}
