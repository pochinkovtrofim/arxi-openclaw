import { TOOL_NAME_SEPARATOR } from "../agents/agent-bundle-mcp-names.js";
// Private helper surface for the bundled Codex plugin. Mirrors the Codex CLI
// runtime's user-mcp-server projection so the bundled Codex app-server harness
// can attach the same user `mcp.servers` entries to its thread config without
// deep-importing core helpers.
import { pinExecToolTarget } from "../agents/exec-tool-target-pinning.js";
import type { AgentHarnessHostCapabilities } from "../agents/harness/host-capability-types.js";
import {
  resolveAgentHarnessScheduledToolProjectionCapability,
  resolveAgentHarnessTtsProvenanceTransferCapability,
  type AgentHarnessScheduledToolProjectionFactory,
  type AgentHarnessTtsProvenanceTransfer,
} from "../agents/harness/host-private-capabilities.js";
import { normalizeToolPolicyName, readToolAllowlistIntersection } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../agents/tools/cron-tool.types.js";
import {
  normalizeCronScheduledMcpToolBindings,
  type CronScheduledMcpToolBinding,
} from "../cron/scheduled-tool-policy.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";

export { pinExecToolTarget };
export type CodexScheduledToolProjectionFactory = AgentHarnessScheduledToolProjectionFactory;
export type CodexTtsProvenanceTransfer = AgentHarnessTtsProvenanceTransfer;

/** True only when at least one effective intersection layer is an exact finite cap. */
export function hasExplicitFiniteCodexToolAllowlist(toolsAllow: string[] | undefined): boolean {
  if (!Array.isArray(toolsAllow)) {
    return false;
  }
  const restrictions = readToolAllowlistIntersection(toolsAllow) ?? [toolsAllow];
  return restrictions.some((restriction) =>
    restriction.every((entry) => {
      const normalized = normalizeToolPolicyName(entry);
      return (
        Boolean(normalized) &&
        normalized !== "bundle-mcp" &&
        !normalized.includes("*") &&
        !normalized.startsWith("group:")
      );
    }),
  );
}

/** Prevent cross-partition name ownership changes when scoped allocation is not exact. */
export function shouldWithholdStaticCodexMcp(params: {
  scheduledAccountMcp: boolean;
  hasRequesterScopedMcp: boolean;
  toolsAllow: string[] | undefined;
  resolverDiagnosticNotice?: string;
}): boolean {
  return (
    params.scheduledAccountMcp &&
    params.hasRequesterScopedMcp &&
    (!hasExplicitFiniteCodexToolAllowlist(params.toolsAllow) ||
      params.resolverDiagnosticNotice !== undefined)
  );
}

type CodexMcpNameAllocation = {
  name: string;
  identity: string;
};

export type ScheduledCodexMcpIdentityBindingResult = {
  allowedNames: ReadonlySet<string>;
  rejectedNames: readonly string[];
};

function persistedMcpIdentity(binding: CronScheduledMcpToolBinding): string {
  return JSON.stringify([binding.serverName, binding.operation, binding.toolName]);
}

/** Rebind persisted names only to the exact canonical MCP identities that created them. */
export function resolveScheduledCodexMcpIdentityBindings(params: {
  bindings: unknown;
  allocations: readonly CodexMcpNameAllocation[];
  exposedNames: readonly string[];
  persistedCapNames?: readonly string[];
}): ScheduledCodexMcpIdentityBindingResult {
  const bindings = normalizeCronScheduledMcpToolBindings(params.bindings);
  if (!bindings) {
    // An absent/invalid map is a legacy authority boundary, not proof that the
    // old finite cap belonged to ordinary tools. Quarantine every exact name:
    // otherwise a disappeared MCP capability could transfer to a new base tool.
    const legacyNames = (params.persistedCapNames ?? [])
      .map(normalizeToolPolicyName)
      .filter(
        (name) =>
          Boolean(name) &&
          name !== "bundle-mcp" &&
          !name.includes("*") &&
          !name.startsWith("group:") &&
          name.includes(TOOL_NAME_SEPARATOR),
      );
    return {
      allowedNames: new Set(),
      rejectedNames: [
        ...new Set([...params.exposedNames.map(normalizeToolPolicyName), ...legacyNames]),
      ]
        .filter(Boolean)
        .toSorted(),
    };
  }
  const expectedByName = new Map(
    bindings.map((binding) => [binding.name, persistedMcpIdentity(binding)] as const),
  );
  const currentByName = new Map<string, string>();
  const ambiguousCurrentNames = new Set<string>();
  for (const allocation of params.allocations) {
    const name = normalizeToolPolicyName(allocation.name);
    const existing = currentByName.get(name);
    if (existing !== undefined && existing !== allocation.identity) {
      ambiguousCurrentNames.add(name);
    } else if (name) {
      currentByName.set(name, allocation.identity);
    }
  }
  const allowedNames = new Set<string>();
  const rejectedNames = new Set<string>();
  for (const [name, identity] of expectedByName) {
    if (!ambiguousCurrentNames.has(name) && currentByName.get(name) === identity) {
      allowedNames.add(name);
    } else {
      rejectedNames.add(name);
    }
  }
  for (const exposedName of params.exposedNames) {
    const name = normalizeToolPolicyName(exposedName);
    if (name && !allowedNames.has(name)) {
      rejectedNames.add(name);
    }
  }
  return { allowedNames, rejectedNames: [...rejectedNames].toSorted() };
}

/** Resolve the private scheduled-tool projection issuer for the Codex harness owner. */
export function resolveCodexScheduledToolProjectionFactory(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexScheduledToolProjectionFactory | undefined {
  return resolveAgentHarnessScheduledToolProjectionCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

/** Resolve private TTS delivery transfer for the bundled Codex harness owner. */
export function resolveCodexTtsProvenanceTransfer(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexTtsProvenanceTransfer | undefined {
  return resolveAgentHarnessTtsProvenanceTransferCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

export {
  buildCodexUserMcpServersThreadConfigPatch,
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
  buildCodexUserMcpServersThreadConfigPatchForRun,
  resolveCodexMcpToolOverridesForAgent,
} from "../agents/cli-runner/bundle-mcp-codex.js";
export {
  runWithCronCreatorAuthorityCapabilityResolver,
  runWithCronCreatorAuthorityResolver,
} from "../agents/cron-creator-authority-context.js";

/** Materialize static configured MCP under a scheduled Codex authority envelope. */
export async function materializeStaticMcpToolsForScheduledHarnessRun(
  params: Parameters<
    typeof import("../agents/agent-bundle-mcp-harness.js").materializeStaticMcpToolsForScheduledHarnessRunCore
  >[0],
) {
  const { materializeStaticMcpToolsForScheduledHarnessRunCore: materialize } =
    await import("../agents/agent-bundle-mcp-harness.js");
  return materialize(params);
}

/** Capture the final Codex dynamic-tool surface for cron creator authority. */
export async function captureFinalCodexCronCreatorToolAllowlist(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly AnyAgentTool[],
) {
  const { captureFinalEffectiveCronCreatorToolAllowlist: capture } =
    await import("../agents/tools/cron-tool.js");
  return capture(target, captureRef, tools, (tool) => getPluginToolMeta(tool));
}
