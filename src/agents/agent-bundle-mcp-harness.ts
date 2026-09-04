/** Harness-facing materialization of configured MCP tools. */
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { copyPluginToolMeta, getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
  getOrCreateSessionMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
  retireSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-api.js";
import {
  buildBundleMcpToolsFromCatalog,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import { buildSafeToolName, normalizeReservedToolNames } from "./agent-bundle-mcp-names.js";
import { mergeMcpConnectCatalog } from "./agent-bundle-mcp-requester-connect.js";
import type { McpToolCatalog, RequesterMcpConnect } from "./agent-bundle-mcp-types.js";
import {
  resolveConversationCapabilityProfile,
  type ConversationCapabilityProfileParams,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { requiresMcpCodexToolApproval } from "./mcp-codex-tool-approval.js";
import type { AnyAgentTool } from "./tools/common.js";

type RequesterScopedHarnessMcpTools = {
  /** Executable tools for this turn (live binding or not-connected stubs). */
  tools: AnyAgentTool[];
  /**
   * Session-stable advertised tool surface for dynamic-tool fingerprints.
   * Identical for every sender once the session has observed a scoped catalog.
   */
  advertisedTools: AnyAgentTool[];
  /** All stable allocated names, including tools later removed by scheduled policy. */
  allocatedToolNames?: readonly string[];
  /** Canonical identity bindings used to reject cross-partition name collisions. */
  mcpNameAllocations?: readonly HarnessMcpNameAllocation[];
  /** Bounded scheduled warning when resolver binding or approval policy was incomplete. */
  diagnosticNotice?: string;
  dispose: () => Promise<void>;
};

type ScheduledStaticHarnessMcpTools = {
  /** Final executable static MCP tools for this scheduled turn. */
  tools: AnyAgentTool[];
  /** Canonical identity bindings used to reject cross-partition name collisions. */
  mcpNameAllocations?: readonly HarnessMcpNameAllocation[];
  /** Bounded model/operator warning when configured servers or final policy were incomplete. */
  diagnosticNotice?: string;
  dispose: () => Promise<void>;
};

type HarnessMcpNameAllocation = {
  name: string;
  baseName: string;
  identity: string;
};

function buildMcpNameAllocations(
  tools: readonly AnyAgentTool[],
  baseReservedToolNames?: Iterable<string>,
): HarnessMcpNameAllocation[] {
  const initialReserved = normalizeReservedToolNames(baseReservedToolNames);
  return tools.flatMap((tool) => {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (!mcp) {
      return [];
    }
    return [
      {
        name: tool.name,
        baseName: buildSafeToolName({
          serverName: mcp.safeServerName,
          toolName: mcp.toolName,
          reservedNames: new Set(initialReserved),
        }),
        identity: JSON.stringify([mcp.serverName, mcp.operation, mcp.toolName]),
      },
    ];
  });
}

function formatScheduledMcpDiagnosticNotice(messages: readonly string[]): string | undefined {
  const bounded = [...new Set(messages)]
    .map((message) => message.replaceAll(/\s+/g, " ").trim().slice(0, 180))
    .filter(Boolean)
    .slice(0, 4);
  if (bounded.length === 0) {
    return undefined;
  }
  return (
    `Configured MCP is incomplete for this scheduled run: ${bounded.join("; ")}. ` +
    "Do not claim MCP-backed work succeeded; report this blocker to the operator."
  );
}

function isScheduledCodexApprovalAllowed(tool: AnyAgentTool, autoApprove: boolean): boolean {
  const mcp = getPluginToolMeta(tool)?.mcp;
  return (
    mcp?.operation !== "tool" ||
    autoApprove ||
    (mcp.codexApproval !== undefined && !requiresMcpCodexToolApproval(mcp.codexApproval))
  );
}

function filterScheduledCodexApproval(
  tools: readonly AnyAgentTool[],
  autoApprove: boolean,
  onOmitted?: (message: string) => void,
): AnyAgentTool[] {
  return tools.filter((tool) => {
    if (isScheduledCodexApprovalAllowed(tool, autoApprove)) {
      return true;
    }
    const mcp = getPluginToolMeta(tool)?.mcp;
    onOmitted?.(
      `${mcp?.serverName ?? "configured MCP"}/${mcp?.toolName ?? tool.name}: requires interactive Codex approval (${mcp?.codexApproval?.mode ?? "auto"}); configure codex.defaultToolsApprovalMode="approve" or use the host-confirmed yolo profile`,
    );
    return false;
  });
}

type MaterializeRequesterScopedMcpToolsForHarnessRunParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  chatType?: string | null;
  conversationId?: string | null;
  runtimeGeneration?: string | null;
  traceId?: string | null;
  reservedToolNames?: Iterable<string>;
  toolsAllow?: string[];
  /** When set, applies the same final effective tool policy as the embedded runner. */
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  /** Builds a capability profile when conversationCapabilityProfile is omitted. */
  policyContext?: Omit<ConversationCapabilityProfileParams, "runtimeToolAllowlist">;
  /** Applies unattended Codex approval gating and surfaces resolver failures. */
  scheduledCodexApproval?: { autoApprove: boolean };
  warn?: (message: string) => void;
};

function notConnectedToolResult(serverName: string, toolName: string) {
  const message = `Requester has not connected MCP server "${serverName}" (tool "${toolName}") for this turn.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      status: "error" as const,
      error: message,
      mcpServer: serverName,
      mcpTool: toolName,
    },
  };
}

function applyHarnessToolPolicy(
  tools: AnyAgentTool[],
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): AnyAgentTool[] {
  if (tools.length === 0) {
    return tools;
  }
  const allowed = applyEmbeddedAttemptToolsAllow(tools, params.toolsAllow, {
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const profile =
    params.conversationCapabilityProfile ??
    (params.policyContext
      ? resolveConversationCapabilityProfile({
          ...params.policyContext,
          runtimeToolAllowlist: params.toolsAllow,
        })
      : undefined);
  if (!profile) {
    return allowed;
  }
  return applyFinalEffectiveToolPolicy({
    bundledTools: allowed,
    config: params.policyContext?.config ?? params.cfg,
    conversationCapabilityProfile: profile,
    warn: params.warn ?? (() => undefined),
  });
}

function canonicalMcpToolIdentity(tool: AnyAgentTool): string | undefined {
  const mcp = getPluginToolMeta(tool)?.mcp;
  return mcp ? JSON.stringify([mcp.serverName, mcp.operation, mcp.toolName]) : undefined;
}

function bindLiveMcpExecutor(advertised: AnyAgentTool, live: AnyAgentTool): AnyAgentTool {
  const bound = { ...live, ...advertised, execute: live.execute };
  // Stable names and schemas come from the advertised surface, but approval
  // and side-effect metadata must always come from the current live binding.
  copyPluginToolMeta(live, bound);
  return bound;
}

function buildCatalogTools(
  catalog: McpToolCatalog,
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
  requesterConnect?: RequesterMcpConnect,
): AnyAgentTool[] {
  return buildBundleMcpToolsFromCatalog({
    catalog,
    reservedToolNames: params.reservedToolNames ? Array.from(params.reservedToolNames) : undefined,
    createExecute: (tool) => {
      return (
        requesterConnect?.createExecute(tool.serverName) ??
        (async () => notConnectedToolResult(tool.serverName, tool.toolName))
      );
    },
  });
}

/**
 * Materialize only static configured MCP for an authenticated scheduled turn.
 * No requester identity is accepted here, so requester resolvers stay unreachable.
 */
export async function materializeStaticMcpToolsForScheduledHarnessRunCore(
  params: Omit<
    MaterializeRequesterScopedMcpToolsForHarnessRunParams,
    "requesterSenderId" | "agentAccountId" | "messageChannel"
  > & {
    toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
    /** Exact established Codex yolo predicate; no other profile bypasses approval metadata. */
    autoApproveCodexAppServerApprovals?: boolean;
    /** Mutation-only probes retire their isolated runtime after the snapshot. */
    retireSessionRuntimeAfterDispose?: boolean;
    /** Names reserved before requester/static MCP partitions are allocated. */
    nameOwnershipBaseReservedToolNames?: Iterable<string>;
  },
): Promise<ScheduledStaticHarnessMcpTools> {
  const runtime = await getOrCreateSessionMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    toolOverrides: params.toolOverrides,
  });
  const retireSnapshotRuntime = params.retireSessionRuntimeAfterDispose
    ? async () => {
        await retireSessionMcpRuntime({
          sessionId: params.sessionId,
          reason: "scheduled-authority-snapshot-complete",
        });
      }
    : undefined;
  let liveRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>;
  try {
    liveRuntime = await materializeBundleMcpToolsForRun({
      runtime,
      agentId: params.agentId,
      reservedToolNames: params.reservedToolNames,
      ...(retireSnapshotRuntime ? { disposeRuntime: retireSnapshotRuntime } : {}),
    });
  } catch (error) {
    await retireSnapshotRuntime?.();
    throw error;
  }
  try {
    const policyWarnings: string[] = [];
    const policyParams = {
      ...params,
      warn: (message: string) => {
        policyWarnings.push(message);
        params.warn?.(message);
      },
    };
    const allowed = filterScheduledCodexApproval(
      applyHarnessToolPolicy(liveRuntime.tools, policyParams),
      params.autoApproveCodexAppServerApprovals === true,
      (message) => policyWarnings.push(message),
    );
    // App views outlive this attempt, so bind their callable surface to the
    // same complete catalog and final policy before any model tool can mint one.
    liveRuntime.restrictAppTools?.(
      filterScheduledCodexApproval(
        applyHarnessToolPolicy(liveRuntime.appTools ?? liveRuntime.tools, policyParams),
        params.autoApproveCodexAppServerApprovals === true,
        (message) => policyWarnings.push(message),
      ),
    );
    const diagnosticNotice = formatScheduledMcpDiagnosticNotice([
      ...(liveRuntime.diagnostics ?? []).map(
        (diagnostic) => `${diagnostic.serverName}: ${diagnostic.message}`,
      ),
      ...policyWarnings,
    ]);
    let disposed = false;
    return {
      tools: allowed,
      mcpNameAllocations: buildMcpNameAllocations(
        liveRuntime.tools,
        params.nameOwnershipBaseReservedToolNames ?? params.reservedToolNames,
      ),
      ...(diagnosticNotice ? { diagnosticNotice } : {}),
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        await liveRuntime.dispose();
      },
    };
  } catch (error) {
    await liveRuntime.dispose();
    throw error;
  }
}

/**
 * Materialize requester-scoped MCP tools for a harness run (e.g. Codex dynamic tools).
 * Updates the session advertised-catalog cache when a requester resolves a catalog.
 * Before any requester resolves in the session, returns undefined (nothing to advertise).
 */
export async function materializeRequesterScopedMcpToolsForHarnessRunCore(
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): Promise<RequesterScopedHarnessMcpTools | undefined> {
  const scheduledWarnings: string[] = [];
  const scopedRuntimeHandle = await getOrCreateRequesterScopedMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    toolOverrides: params.toolOverrides,
    requesterSenderId: params.requesterSenderId,
    agentAccountId: params.agentAccountId,
    messageChannel: params.messageChannel,
    agentId: params.agentId,
    chatType: params.chatType,
    conversationId: params.conversationId,
    runtimeGeneration: params.runtimeGeneration,
    traceId: params.traceId,
    ...(params.scheduledCodexApproval
      ? {
          onResolverUnavailable: (diagnostic) => {
            scheduledWarnings.push(
              `${diagnostic.serverName}: background connection ${diagnostic.reason}`,
            );
          },
        }
      : {}),
  });
  const scopedRuntime = scopedRuntimeHandle?.runtime;

  let liveRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let liveCatalog: McpToolCatalog | undefined;
  try {
    if (scopedRuntime) {
      liveRuntime = await materializeBundleMcpToolsForRun({
        runtime: scopedRuntime,
        agentId: params.agentId,
        reservedToolNames: params.reservedToolNames,
      });
      liveCatalog = scopedRuntime.peekCatalog() ?? (await scopedRuntime.getCatalog());
      if (params.scheduledCodexApproval) {
        scheduledWarnings.push(
          ...(liveRuntime.diagnostics ?? []).map(
            (diagnostic) => `${diagnostic.serverName}: ${diagnostic.message}`,
          ),
        );
      }
      if (scopedRuntimeHandle) {
        rememberAdvertisedScopedMcpCatalog(scopedRuntimeHandle, liveCatalog);
      }
    }

    const advertisedBase = getAdvertisedScopedMcpCatalog(params.sessionId) ?? liveCatalog;
    const advertisedCatalog = advertisedBase
      ? mergeMcpConnectCatalog(advertisedBase, scopedRuntime?.requesterConnect)
      : undefined;
    if (!advertisedCatalog) {
      await liveRuntime?.dispose();
      const diagnosticNotice = formatScheduledMcpDiagnosticNotice(scheduledWarnings);
      return diagnosticNotice
        ? {
            tools: [],
            advertisedTools: [],
            allocatedToolNames: [],
            mcpNameAllocations: [],
            diagnosticNotice,
            dispose: async () => undefined,
          }
        : undefined;
    }

    const reservedToolNames = params.reservedToolNames
      ? Array.from(params.reservedToolNames)
      : undefined;
    const advertisedTools = buildCatalogTools(
      advertisedCatalog,
      { ...params, reservedToolNames },
      scopedRuntime?.requesterConnect,
    );
    const liveByIdentity = new Map<string, AnyAgentTool>();
    for (const tool of liveRuntime?.tools ?? []) {
      const identity = canonicalMcpToolIdentity(tool);
      if (identity) {
        liveByIdentity.set(identity, tool);
      }
    }
    // Live tools supply execution; advertised catalog supplies the stable name/schema surface.
    const tools = advertisedTools.map((tool) => {
      const identity = canonicalMcpToolIdentity(tool);
      const live = identity ? liveByIdentity.get(identity) : undefined;
      return live ? bindLiveMcpExecutor(tool, live) : tool;
    });

    const applyScheduledPolicy = (candidates: AnyAgentTool[]) => {
      const policyFiltered = applyHarnessToolPolicy(candidates, params);
      return params.scheduledCodexApproval
        ? filterScheduledCodexApproval(
            policyFiltered,
            params.scheduledCodexApproval.autoApprove,
            (message) => scheduledWarnings.push(message),
          )
        : policyFiltered;
    };
    // A scheduled run may execute only a current live binding. Ordinary
    // requester turns retain not-connected stubs for their sign-in UX.
    const executableCandidates = params.scheduledCodexApproval
      ? tools.filter((tool) => {
          const identity = canonicalMcpToolIdentity(tool);
          return identity !== undefined && liveByIdentity.has(identity);
        })
      : tools;
    const filteredTools = applyScheduledPolicy(executableCandidates);
    const policyAdvertised = applyScheduledPolicy(advertisedTools);
    // Scheduled advertisement is the intersection with the current live,
    // approval-safe surface. This prevents a stale permissive catalog row from
    // making a newly destructive tool appear runnable.
    const executableNames = new Set(filteredTools.map((tool) => tool.name));
    const filteredAdvertised = params.scheduledCodexApproval
      ? policyAdvertised.filter((tool) => executableNames.has(tool.name))
      : policyAdvertised;
    const allowedNames = new Set(filteredAdvertised.map((tool) => tool.name));
    const executableTools = filteredTools.filter((tool) => allowedNames.has(tool.name));
    const diagnosticNotice = formatScheduledMcpDiagnosticNotice(scheduledWarnings);

    let disposed = false;
    return {
      tools: executableTools,
      advertisedTools: filteredAdvertised,
      allocatedToolNames: advertisedTools.map((tool) => tool.name),
      mcpNameAllocations: buildMcpNameAllocations(advertisedTools, params.reservedToolNames),
      ...(diagnosticNotice ? { diagnosticNotice } : {}),
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        await liveRuntime?.dispose();
      },
    };
  } catch (error) {
    await liveRuntime?.dispose();
    throw error;
  }
}
