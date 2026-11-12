// Scheduler proposals a paced cron run records for its own next trigger.
import { getAgentRunContext, hasAgentRunContextExecutionOwner } from "./agent-run-registry.js";

/** Records the latest next-check proposal on the matching live cron run. */
export function recordCronNextCheckProposal(runId: string, jobId: string, delayMs: number): void {
  const context = getAgentRunContext(runId);
  const cronRun = context?.cronRunsByJobId?.get(jobId);
  if (!cronRun || !hasAgentRunContextExecutionOwner(runId)) {
    throw new Error("cron next_check is only available to the currently running job");
  }
  if (!cronRun.nextCheckEnabled) {
    throw new Error("cron next_check requires pacing or a one-shot session continuation");
  }
  if (cronRun.nextCheckSource === "managed_flow_obligation") {
    throw new Error("cron next_check conflicts with a managed Flow obligation in the current job");
  }
  cronRun.nextCheckMs = delayMs;
  cronRun.nextCheckSource = "next_check";
}

/** Returns the current paced scheduler binding without accepting caller-supplied job identity. */
export function getCurrentPacedCronRunBinding(runId: string):
  | {
      jobId: string;
      cronStoreKey: string;
      cronScheduleIdentity: string;
      pacingEnabled: true;
      scheduledAutomation: true;
      nextCheckSource?: "next_check" | "managed_flow_obligation";
    }
  | undefined {
  const cronRuns = getAgentRunContext(runId)?.cronRunsByJobId;
  if (!cronRuns || cronRuns.size !== 1) {
    return undefined;
  }
  const [entry] = cronRuns;
  if (!entry) {
    return undefined;
  }
  const [jobId, cronRun] = entry;
  if (
    !cronRun.pacingEnabled ||
    cronRun.scheduledAutomation !== true ||
    !cronRun.cronStoreKey ||
    !cronRun.cronScheduleIdentity
  ) {
    return undefined;
  }
  return {
    jobId,
    cronStoreKey: cronRun.cronStoreKey,
    cronScheduleIdentity: cronRun.cronScheduleIdentity,
    pacingEnabled: true,
    scheduledAutomation: true,
    ...(cronRun.nextCheckSource ? { nextCheckSource: cronRun.nextCheckSource } : {}),
  };
}

/** Records the one scheduler proposal attached to a durable managed Flow receipt. */
export function recordManagedFlowAutomationObligationProposal(params: {
  runId: string;
  jobId: string;
  delayMs: number;
  scheduledAtMs: number;
}): void {
  if (
    !Number.isSafeInteger(params.delayMs) ||
    params.delayMs <= 0 ||
    !Number.isSafeInteger(params.scheduledAtMs)
  ) {
    throw new Error("managed Flow obligation requires a future trigger");
  }
  const cronRun = getAgentRunContext(params.runId)?.cronRunsByJobId?.get(params.jobId);
  if (!cronRun?.pacingEnabled) {
    throw new Error("managed Flow obligation is only available to the current paced job");
  }
  if (cronRun.nextCheckSource === "next_check") {
    throw new Error("managed Flow obligation conflicts with an existing cron next_check");
  }
  cronRun.nextCheckMs = params.delayMs;
  cronRun.nextCheckAtMs = params.scheduledAtMs;
  cronRun.nextCheckSource = "managed_flow_obligation";
}

/** Consumes one successful cron run's proposal so it cannot affect a later run. */
export function consumeCronNextCheckProposal(
  runId: string,
  jobId: string,
): { delayMs: number; scheduledAtMs?: number } | undefined {
  const context = getAgentRunContext(runId);
  const cronRuns = context?.cronRunsByJobId;
  const cronRun = cronRuns?.get(jobId);
  if (!cronRun) {
    return undefined;
  }
  cronRuns?.delete(jobId);
  if (cronRuns?.size === 0 && context) {
    delete context.cronRunsByJobId;
  }
  return cronRun.nextCheckMs === undefined
    ? undefined
    : {
        delayMs: cronRun.nextCheckMs,
        ...(cronRun.nextCheckAtMs !== undefined ? { scheduledAtMs: cronRun.nextCheckAtMs } : {}),
      };
}
