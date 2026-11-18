import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../../agents/embedded-agent-runner/usage-accumulator.js";
import { deriveContextPromptTokens, hasBillableUsage } from "../../agents/usage.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { projectCronRunUsage } from "../run-telemetry.js";
import type { CronRunTelemetry } from "../types.js";
import type { PreparedCronRunContext } from "./run-prepare.js";
import { DEFAULT_CONTEXT_TOKENS, hasNonzeroUsage } from "./run.runtime.js";
import type { CronCompletedPromptRun } from "./run.types.js";

const cronContextRuntimeLoader = createLazyImportLoader(() => import("./run-context.runtime.js"));

/**
 * A run's billing usage: the CLI's terminal cumulative usage covers every model call of the
 * prompt, while `usage` is only the last call's snapshot there.
 */
function cronPromptBillingUsage(run: CronCompletedPromptRun) {
  const meta = run.runResult.meta?.agentMeta;
  return hasBillableUsage(meta?.diagnosticUsage) ? meta?.diagnosticUsage : meta?.usage;
}

export function resolveCronRunUsage(runs: readonly CronCompletedPromptRun[]) {
  if (runs.length === 1) {
    return runs[0] ? cronPromptBillingUsage(runs[0]) : undefined;
  }
  const accumulated = createUsageAccumulator();
  for (const run of runs) {
    const usage = cronPromptBillingUsage(run);
    if (!usage) {
      continue;
    }
    const bucketTotal =
      (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    mergeUsageIntoAccumulator(accumulated, {
      ...usage,
      total: Math.max(bucketTotal, asNonNegativeFiniteNumber(usage.total) ?? 0),
    });
  }
  return toNormalizedUsage(accumulated);
}

export function applyCronRunUsage(
  prepared: PreparedCronRunContext,
  runs: readonly CronCompletedPromptRun[],
): CronRunTelemetry["usage"] {
  const usage = resolveCronRunUsage(runs);
  if (!hasNonzeroUsage(usage) && !hasNonzeroUsage(runs.at(-1)?.runResult.meta?.agentMeta?.usage)) {
    return undefined;
  }
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;
  prepared.cronSession.sessionEntry.inputTokens = input;
  prepared.cronSession.sessionEntry.outputTokens = output;
  prepared.cronSession.sessionEntry.cacheRead = cacheRead;
  prepared.cronSession.sessionEntry.cacheWrite = cacheWrite;
  return projectCronRunUsage(usage);
}

/** Preserve each completed prompt's prices and diagnostics across a continuation. */
export async function recordCronRunUsage(params: {
  prepared: PreparedCronRunContext;
  runs: readonly CronCompletedPromptRun[];
  contextTokens?: number;
}): Promise<void> {
  const { prepared, runs } = params;
  const billableRuns = runs.filter((run) => hasBillableUsage(cronPromptBillingUsage(run)));
  if (billableRuns.length === 0) {
    return;
  }
  const { estimateAggregateUsageCost, resolveModelCostConfig } =
    await import("../../utils/usage-format.js");
  let estimatedCostUsd: number | undefined = 0;
  let hasSessionUsage = false;
  for (const run of billableRuns) {
    const result = run.runResult;
    const meta = result.meta?.agentMeta;
    const usage = cronPromptBillingUsage(run);
    const provider = meta?.provider ?? run.fallbackProvider;
    const model = meta?.model ?? run.fallbackModel;
    const costConfig = resolveModelCostConfig({
      provider,
      model,
      config: prepared.cfgWithAgentDefaults,
      agentDir: prepared.agentDir,
    });
    if (hasBillableUsage(usage)) {
      hasSessionUsage = true;
      const cost = asNonNegativeFiniteNumber(
        estimateAggregateUsageCost({ usage, cost: costConfig }),
      );
      estimatedCostUsd =
        estimatedCostUsd !== undefined && cost !== undefined ? estimatedCostUsd + cost : undefined;
    }
    if (
      !isDiagnosticsEnabled(prepared.cfgWithAgentDefaults) ||
      !hasBillableUsage(usage)
    ) {
      continue;
    }
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const promptTokens = input + cacheRead + cacheWrite;
    const bucketTotalTokens = promptTokens + output;
    const total =
      typeof usage.total === "number" && Number.isFinite(usage.total)
        ? Math.max(bucketTotalTokens, usage.total)
        : bucketTotalTokens;
    const costUsd = asNonNegativeFiniteNumber(
      estimateAggregateUsageCost({ usage, cost: costConfig }),
    );
    const contextUsedTokens = deriveContextPromptTokens({
      lastCallUsage: meta?.lastCallUsage,
      promptTokens: meta?.promptTokens,
      usage: meta?.usage,
    });
    const contextTokens =
      (result === runs.at(-1)?.runResult ? params.contextTokens : undefined) ??
      asPositiveFiniteNumber(meta?.contextTokens) ??
      (await cronContextRuntimeLoader.load()).resolveModelContextTokenProjection({
        cfg: prepared.cfgWithAgentDefaults,
        provider,
        model,
        allowAsyncLoad: false,
      }).contextTokens ??
      DEFAULT_CONTEXT_TOKENS;
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      ...(result.diagnosticTrace
        ? {
            trace: freezeDiagnosticTraceContext(
              createChildDiagnosticTraceContext(result.diagnosticTrace),
            ),
          }
        : {}),
      sessionKey: prepared.runSessionKey,
      sessionId: prepared.currentRunSessionId(),
      channel: "cron",
      agentId: prepared.agentId,
      provider,
      model,
      usage: { input, output, cacheRead, cacheWrite, promptTokens, total },
      lastCallUsage: meta?.lastCallUsage,
      context: {
        limit: contextTokens,
        ...(contextUsedTokens !== undefined ? { used: contextUsedTokens } : {}),
      },
      ...(costUsd !== undefined ? { costUsd } : {}),
      durationMs: run.runEndedAt - run.runStartedAt,
    });
  }
  if (hasSessionUsage) {
    // Missing prices stay unknown; repricing the sum with the final model would misbill earlier prompts.
    prepared.cronSession.sessionEntry.estimatedCostUsd = estimatedCostUsd;
  }
}
