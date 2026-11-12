import {
  embeddedAgentLog,
  materializeRequesterScopedMcpToolsForHarnessRun,
  type EmbeddedRunAttemptParams,
  type ExecApprovalDecision,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  formatMcpCodexApprovalRemedy,
  hasExplicitFiniteCodexToolAllowlist,
  resolveScheduledCodexMcpIdentityBindings,
  type materializeStaticMcpToolsForHarnessRun,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { requestPluginApprovalOutcome } from "./plugin-approval-roundtrip.js";
import { formatScheduledMcpIdentityMismatch } from "./scheduled-mcp-identity.js";

type HarnessMcpInteractiveApproval = NonNullable<
  Parameters<
    typeof materializeRequesterScopedMcpToolsForHarnessRun
  >[0]["requestInteractiveCodexApproval"]
>;
type ScopedMcpOptions = Parameters<typeof materializeRequesterScopedMcpToolsForHarnessRun>[0];
type ScopedMcpTools = Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>>;
type ConfiguredMcpTools =
  | Awaited<ReturnType<typeof materializeStaticMcpToolsForHarnessRun>>
  | undefined;

/**
 * Per-call MCP approval for dynamic (bridge) tools, the same boundary as the configured
 * path before any executor dispatch. Requester-scoped tools never consume stored grants
 * (requester servers are excluded from the native grant projection), so they offer only
 * allow-once or deny: Allow Always would re-prompt on every subsequent call.
 */
export function createCodexMcpInteractiveApproval(
  hostCapabilities: EmbeddedRunAttemptParams["hostCapabilities"],
  requesterScoped: boolean,
): HarnessMcpInteractiveApproval {
  return async (approval) => {
    const allowedDecisions: ExecApprovalDecision[] =
      requesterScoped || approval.mode === "prompt"
        ? ["allow-once", "deny"]
        : ["allow-once", "allow-always", "deny"];
    const outcome = await requestPluginApprovalOutcome({
      hostCapabilities,
      signal: approval.signal,
      title: `Run MCP tool ${approval.serverName}/${approval.toolName}`,
      description: `Codex approval mode "${approval.mode}" requires an operator decision before this MCP tool runs. ${formatMcpCodexApprovalRemedy(approval.serverName)}`,
      allowedDecisions,
      toolName: approval.safeToolName,
      toolCallId: approval.toolCallId,
      mcpTool: { server: approval.serverName, tool: approval.toolName },
      isMcpToolApprovalActive: approval.isActive,
    });
    if (outcome !== "approved-once" && outcome !== "approved-session") {
      throw new Error(
        `${approval.serverName}/${approval.toolName}: interactive Codex approval (${approval.mode}) was not granted: ${outcome}`,
      );
    }
  };
}

/** An empty scoped MCP surface that tells the scheduled agent why MCP is missing. */
export function createBlockedScopedMcpTools(diagnosticNotice: string): NonNullable<ScopedMcpTools> {
  return {
    tools: [],
    advertisedTools: [],
    allocatedToolNames: [],
    diagnosticNotice,
    dispose: async () => undefined,
  };
}

/**
 * Keeps only MCP tools whose persisted identity still matches an account automation's
 * grant. Returns the scoped surface (created when a notice must be carried) and the
 * rejected names, which no other dynamic tool may inherit.
 */
export function applyScheduledMcpIdentityBindings(params: {
  bindings: NonNullable<EmbeddedRunAttemptParams["scheduledToolPolicy"]>["mcpToolBindings"];
  toolsAllow: EmbeddedRunAttemptParams["toolsAllow"];
  scopedMcpTools: ScopedMcpTools;
  configuredMcp: ConfiguredMcpTools;
}): { scopedMcpTools: ScopedMcpTools; rejectedNames: Set<string> } {
  let { scopedMcpTools } = params;
  const { configuredMcp } = params;
  const mcpIdentityBindings = resolveScheduledCodexMcpIdentityBindings({
    bindings: params.bindings,
    allocations: [
      ...(scopedMcpTools?.mcpNameAllocations ?? []),
      ...(configuredMcp?.mcpNameAllocations ?? []),
    ],
    exposedNames: [
      ...(scopedMcpTools?.tools.map((tool) => tool.name) ?? []),
      ...(scopedMcpTools?.advertisedTools.map((tool) => tool.name) ?? []),
      ...(configuredMcp?.tools.map((tool) => tool.name) ?? []),
    ],
    persistedCapNames: params.toolsAllow,
  });
  const allowed = (tool: { name: string }) =>
    mcpIdentityBindings.allowedNames.has(tool.name.trim().toLowerCase());
  if (scopedMcpTools) {
    scopedMcpTools.tools = scopedMcpTools.tools.filter(allowed);
    scopedMcpTools.advertisedTools = scopedMcpTools.advertisedTools.filter(allowed);
  }
  if (configuredMcp) {
    configuredMcp.tools = configuredMcp.tools.filter(allowed);
  }
  if (mcpIdentityBindings.rejectedNames.length > 0) {
    const notice =
      `Configured MCP is incomplete for this scheduled run: persisted tool identity no longer matches (${formatScheduledMcpIdentityMismatch(mcpIdentityBindings.rejectedNames)}). ` +
      "No mismatched MCP tool was exposed; reauthorize the automation from a current owner turn.";
    const carrier = scopedMcpTools ?? configuredMcp;
    if (carrier) {
      carrier.diagnosticNotice = [carrier.diagnosticNotice, notice].filter(Boolean).join(" ");
    } else {
      scopedMcpTools = createBlockedScopedMcpTools(notice);
    }
  }
  return { scopedMcpTools, rejectedNames: new Set(mcpIdentityBindings.rejectedNames) };
}

/**
 * Requester-scoped MCP: dynamic tools on a shared thread, never harness-native MCP.
 * Authenticated scheduled runs resolve them only when the automation may act without a
 * live requester; otherwise they get an empty surface that names the blocker.
 */
export async function materializeCodexScopedMcpTools(input: {
  params: EmbeddedRunAttemptParams;
  authenticatedScheduledMode: boolean;
  hasRequesterScopedMcp: boolean;
  autoApprove: boolean;
  options: Pick<
    ScopedMcpOptions,
    | "workspaceDir"
    | "agentDir"
    | "manifestRegistry"
    | "toolOverrides"
    | "agentId"
    | "reservedToolNames"
    | "policyContext"
  >;
}) {
  const { params, authenticatedScheduledMode, hasRequesterScopedMcp, autoApprove } = input;
  const scheduledAccountMcp =
    authenticatedScheduledMode && params.scheduledToolPolicy?.mode === "account";
  const scheduledTrustedMcp =
    authenticatedScheduledMode && params.scheduledToolPolicy?.mode === "trusted";
  const hasFiniteScheduledAccountCap = hasExplicitFiniteCodexToolAllowlist(params.toolsAllow);
  const mayResolveBackgroundMcp =
    hasRequesterScopedMcp &&
    (scheduledTrustedMcp || (scheduledAccountMcp && hasFiniteScheduledAccountCap));
  const missingScheduledAccountCap =
    scheduledAccountMcp && hasRequesterScopedMcp && !hasFiniteScheduledAccountCap;
  let scopedMcpTools: ScopedMcpTools =
    params.requireWorkspaceOnly === true
      ? undefined
      : authenticatedScheduledMode && !mayResolveBackgroundMcp
        ? missingScheduledAccountCap
          ? createBlockedScopedMcpTools(
              "Configured MCP is incomplete for this scheduled run: the account automation has no explicit finite toolsAllow. Do not claim MCP-backed work succeeded; report this blocker to the operator.",
            )
          : undefined
        : await materializeRequesterScopedMcpToolsForHarnessRun({
            ...input.options,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            cfg: params.config,
            // Authenticated scheduled runs may resolve only providers that explicitly
            // accept canonical agent + session identity without a live requester.
            // Never replay the creator's sender, account, channel, or conversation:
            // per-requester OAuth and requester-required resolvers must stay closed.
            ...(mayResolveBackgroundMcp
              ? {}
              : {
                  requesterSenderId: params.senderId,
                  agentAccountId: params.agentAccountId,
                  messageChannel: params.messageChannel ?? params.messageProvider,
                  chatType: params.chatType,
                  conversationId: params.chatId ?? params.groupId ?? params.messageTo,
                }),
            runtimeGeneration: params.lifecycleGeneration,
            traceId: params.diagnosticTrace?.traceId,
            toolsAllow: params.toolsAllow,
            ...(mayResolveBackgroundMcp
              ? { scheduledCodexApproval: { autoApprove } }
              : {
                  autoApproveCodexAppServerApprovals: autoApprove,
                  requestInteractiveCodexApproval: createCodexMcpInteractiveApproval(
                    params.hostCapabilities,
                    true,
                  ),
                }),
            warn: (message) => embeddedAgentLog.warn(message),
          });
  if (mayResolveBackgroundMcp && !scopedMcpTools) {
    scopedMcpTools = createBlockedScopedMcpTools(
      "Configured MCP is incomplete for this scheduled run: the background connection catalog is unavailable. Do not claim MCP-backed work succeeded; report this blocker to the operator.",
    );
  }
  return { scopedMcpTools, scheduledAccountMcp, hasRequesterScopedMcp, mayResolveBackgroundMcp };
}
