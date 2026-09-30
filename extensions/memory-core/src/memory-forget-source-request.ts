import {
  resolveAgentWorkspaceDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemoryForgetReport } from "./memory-forget-report.js";
import { forgetMemorySourceRegions } from "./memory-forget-source-regions.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";

export type MemoryForgetParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionIds?: string[];
  hookSources?: string[];
  participants?: string[];
  since?: string;
  dryRun?: boolean;
  sourceKeys?: string[];
};

export async function forgetMemorySourceEntries(
  params: MemoryForgetParams,
): Promise<MemoryForgetReport> {
  const sourceKeys = params.sourceKeys;
  if (!sourceKeys?.length) {
    throw new Error("Memory source-key forget requires source keys");
  }
  if (
    params.sessionIds?.length ||
    params.hookSources?.length ||
    params.participants?.length ||
    params.since
  ) {
    throw new Error("Memory source-key forget cannot be combined with session selectors");
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const forget = () =>
    forgetMemorySourceRegions({
      workspaceDir,
      agentId: params.agentId,
      sourceKeys,
      dryRun: params.dryRun,
    });
  return params.dryRun ? forget() : withMemoryWorkspaceLock(workspaceDir, forget);
}
