import { resolveScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import {
  resolveAgentRestartRecoveryContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission,
} from "./agent-restart-recovery-context.js";
import { resolveExecutionIdentitySpawnFacts } from "./agent-run-execution-lineage.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/** Grants, execution identity and restart recovery an admitted Gateway run dispatches with. */
export function resolveAgentRunAdmissionInputs(params: StartAgentRunExecutionParams) {
  // Plugin-owned additive grants stay internal to the authenticated in-process run.
  // Public agent params cannot supply them, and normal tool policy still filters them.
  const runtimePluginToolGrant =
    params.client?.internal?.agentRunTracking === "plugin_subagent" &&
    params.client.internal.pluginRuntimeOwnerId ===
      params.client.internal.runtimePluginToolGrant?.pluginId
      ? params.client.internal.runtimePluginToolGrant
      : undefined;
  const pluginSubagentToolsAllow =
    params.client?.internal?.agentRunTracking === "plugin_subagent" &&
    Array.isArray(params.client.internal.pluginSubagentToolsAllow)
      ? [...params.client.internal.pluginSubagentToolsAllow]
      : undefined;
  const executionIdentityAdmission = resolveAgentRestartRecoveryExecutionIdentityAdmission({
    collectionEnabled: isExecutionIdentityCollectionEnabled(params.cfg),
    isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
    retryOnly: params.request.internalExecutionIdentityRetry,
    runId: params.runId,
    sessionEntry: params.sessionEntry,
  });
  const agentRuntimeIdentity = params.client?.internal?.agentRuntimeIdentity;
  const executionIdentitySpawnFacts =
    agentRuntimeIdentity &&
    params.context.validateAgentRuntimeApprovalAuthority?.(agentRuntimeIdentity) === true
      ? resolveExecutionIdentitySpawnFacts(agentRuntimeIdentity)
      : undefined;
  const restartRecoveryContext = resolveAgentRestartRecoveryContext({
    isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
    canUseInternalRuntimeHandoff: params.canUseInternalRuntimeHandoff,
    expectedExistingSessionId: params.request.expectedExistingSessionId,
    resolvedSessionId: params.resolvedSessionId,
    runId: params.runId,
    sessionEntry: params.sessionEntry,
  });  return {
    runtimePluginToolGrant,
    pluginSubagentToolsAllow,
    executionIdentityAdmission,
    executionIdentitySpawnFacts,
    restartRecoveryContext,
  };
}

/** Dispatch fields a restored cron continuation, restart recovery or internal delivery sets. */
export function resolveCronContinuationDispatchFields(params: StartAgentRunExecutionParams) {
  const cron = params.restoredCronContinuation;
  const internal = params.client?.internal;
  return {
    toolsAllowIsDefault: cron?.toolsAllowIsDefault,
    scheduledToolPolicy: cron
      ? resolveScheduledToolPolicyContext({
          toolsAllow: cron.toolsAllow,
          scheduledToolPolicy: cron.scheduledToolPolicy,
          callerOrigin: cron.scheduledToolCallerOrigin,
          execTarget: cron.toolsAllowExecTarget,
          mcpToolBindings: cron.scheduledMcpToolBindings,
        })
      : undefined,
    requireExplicitMessageTarget: cron?.cliSessionBindingFacts?.requireExplicitMessageTarget,
    cliSessionBindingFacts: cron?.cliSessionBindingFacts,
    preserveUserFacingSessionModelState: params.preserveUserFacingSessionModelState && !cron,
    sourceReplyDeliveryMode: cron
      ? cron.cliSessionBindingFacts?.sourceReplyDeliveryMode
      : params.request.sourceReplyDeliveryMode,
    internalDeliveryMediaUrls: internal?.internalDeliveryMediaUrls,
    internalDeliverySuppressText: internal?.internalDeliverySuppressText,
    internalDeliverySuppressErrors: internal?.internalDeliverySuppressErrors,
    ...(params.mainRestartRecoveryOwnerLease
      ? { mainRestartRecoveryOwnerLease: params.mainRestartRecoveryOwnerLease }
      : {}),
    ...(params.isRestartRecoveryResumeRun ? { mainRestartRecoveryAdmitted: true as const } : {}),
    ...(params.request.internalExecutionIdentityRecoveryAttempt !== undefined
      ? { mainRestartRecoveryAttempt: params.request.internalExecutionIdentityRecoveryAttempt }
      : {}),
  };
}
