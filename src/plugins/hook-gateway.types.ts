import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginHookGatewayCronService,
  PluginHookGatewayCronJob,
  PluginHookGatewayCronRunStatus,
  PluginHookGatewayCronDeliveryStatus,
} from "./hook-cron.types.js";
export type { PluginHookGatewayCronService, PluginHookGatewayCronJob } from "./hook-cron.types.js";
/** Gateway lifecycle and cron hook contracts shared by plugin hosts and consumers. */

export type PluginHookGatewayContext = {
  port?: number;
  config?: OpenClawConfig;
  workspaceDir?: string;
  getCron?: () => PluginHookGatewayCronService | undefined;
  /** In gateway_start, aborts at drain to stop producers; gateway_stop owns resource disposal. */
  abortSignal?: AbortSignal;
};

export type PluginHookCronReconciledContext = PluginHookGatewayContext & {
  /** Aborts when this exact scheduler snapshot is superseded or the Gateway closes. */
  abortSignal: AbortSignal;
};

export type PluginHookGatewayStartEvent = {
  port: number;
};

export type PluginHookGatewayStopEvent = {
  reason?: string;
};

export type PluginHookCronReconciledEvent = {
  reason: "startup" | "reload";
  enabled: boolean;
};

export type PluginHookCronChangedEvent = {
  action: "added" | "updated" | "removed" | "started" | "finished" | "scheduled";
  jobId: string;
  job?: PluginHookGatewayCronJob;
  /** Top-level session target for downstream routing (mirrors job.sessionTarget). */
  sessionTarget?: string;
  /** Agent id that owns this cron job (mirrors job.agentId). */
  agentId?: string;
  runAtMs?: number;
  durationMs?: number;
  status?: PluginHookGatewayCronRunStatus;
  completionStatus?: "succeeded" | "failed" | "unknown";
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: PluginHookGatewayCronDeliveryStatus;
  deliveryError?: string;
  deliverySuppressionReason?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
};
