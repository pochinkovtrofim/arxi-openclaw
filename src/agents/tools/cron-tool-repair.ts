/** The scheduler's repair turn may give its failing automation tools this conversation already has. */
import { isCronFailureRepairBroadTool } from "../../gateway/cron-creator-authority-grant.js";
import { isRecord } from "../../utils.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";
import type { GatewayCallOptions } from "./gateway.js";

const REPAIR_ACTIONS = new Set(["get", "update", "run"]);

export function assertCronRepairScope(
  repairJobId: string,
  action: string,
  jobId: string | undefined,
) {
  if (!REPAIR_ACTIONS.has(action) || jobId !== repairJobId) {
    throw new Error(
      `This repair turn can only get, update, or run automation ${repairJobId}. Tell the user about anything else.`,
    );
  }
}

export function describeCronRepairTool(repairJobId: string): string {
  return `Repair only the failing automation ${repairJobId}. Actions: get jobId (its schedule, payload and tools); update jobId job with {payload:{toolsAllow:[...]}} to give its runs tools you have in this conversation (the full list: current tools plus the missing ones, by exact name), or {enabled:false} to pause it; run jobId runMode:"force" to run it now and wait for the result. Other automations and fields are unavailable.`;
}

/** Names this turn can lend: its own final tool surface, by canonical name and alias. */
function readLendableTools(
  surface: readonly CronCreatorToolAllowlistEntry[] | undefined,
  captureRef: CronToolsAllowCaptureRef | undefined,
): Map<string, string> | undefined {
  if (!surface || captureRef?.value?.source !== "final-executable-surface") {
    return undefined;
  }
  const lendable = new Map<string, string>();
  for (const entry of surface) {
    const name = normalizeToolPolicyName(typeof entry === "string" ? entry : entry.name);
    if (!name || isCronFailureRepairBroadTool(name)) {
      continue;
    }
    lendable.set(name, name);
    const alias =
      typeof entry === "string" || !entry.aliasName ? "" : normalizeToolPolicyName(entry.aliasName);
    if (alias) {
      lendable.set(alias, name);
    }
  }
  return lendable;
}

export async function updateCronJobForRepair(params: {
  id: string;
  patch: Record<string, unknown>;
  surface: readonly CronCreatorToolAllowlistEntry[] | undefined;
  captureRef: CronToolsAllowCaptureRef | undefined;
  gatewayOpts: GatewayCallOptions;
  callGateway: (
    method: string,
    opts: GatewayCallOptions,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Signs the update with this turn's MCP identities for the tools it lends. */
  withLentTools?: <T>(toolsAllow: readonly string[], run: () => Promise<T>) => Promise<T>;
}): Promise<unknown> {
  const { payload, enabled, ...other } = params.patch;
  if (Object.keys(other).length > 0 || (enabled !== undefined && enabled !== false)) {
    throw new Error("A repair can change only payload.toolsAllow, or set enabled:false.");
  }
  const patch: Record<string, unknown> = enabled === false ? { enabled: false } : {};
  let expectedConfigRevision: string | undefined;
  if (payload !== undefined) {
    if (
      !isRecord(payload) ||
      Object.keys(payload).some((field) => field !== "kind" && field !== "toolsAllow") ||
      !Array.isArray(payload.toolsAllow)
    ) {
      throw new Error("A repair can change only payload.toolsAllow, or set enabled:false.");
    }
    const lendable = readLendableTools(params.surface, params.captureRef);
    if (!lendable) {
      throw new Error(
        "This turn's tools are not known yet, so it cannot lend them to the automation. Tell the user what is missing instead.",
      );
    }
    const current = await params.callGateway("cron.get", params.gatewayOpts, { id: params.id });
    const currentPayload =
      isRecord(current) && isRecord(current.payload) ? current.payload : undefined;
    const kind = currentPayload?.kind;
    if (kind !== "agentTurn" && kind !== "script") {
      throw new Error("Only an agent or script automation has a tool list to repair.");
    }
    const kept = new Set(
      (Array.isArray(currentPayload?.toolsAllow) ? currentPayload.toolsAllow : [])
        .filter((tool): tool is string => typeof tool === "string")
        .map(normalizeToolPolicyName)
        .filter(Boolean),
    );
    const toolsAllow = new Set<string>();
    const refused: string[] = [];
    for (const requested of payload.toolsAllow) {
      const name = typeof requested === "string" ? normalizeToolPolicyName(requested) : "";
      const canonical = kept.has(name) ? name : lendable.get(name);
      if (canonical) {
        toolsAllow.add(canonical);
      } else {
        refused.push(String(requested));
      }
    }
    if (refused.length > 0) {
      throw new Error(
        `Not available in this conversation, so the automation cannot get them: ${refused.join(", ")}. If its work needs them, tell the user what to connect.`,
      );
    }
    patch.payload = { kind, toolsAllow: [...toolsAllow] };
    expectedConfigRevision =
      isRecord(current) && typeof current.configRevision === "string"
        ? current.configRevision
        : undefined;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("job patch required");
  }
  const update = () =>
    params.callGateway("cron.update", params.gatewayOpts, {
      id: params.id,
      patch,
      ...(expectedConfigRevision ? { expectedConfigRevision } : {}),
    });
  const toolsAllow = isRecord(patch.payload) ? patch.payload.toolsAllow : undefined;
  return Array.isArray(toolsAllow) && params.withLentTools
    ? await params.withLentTools(toolsAllow, update)
    : await update();
}
