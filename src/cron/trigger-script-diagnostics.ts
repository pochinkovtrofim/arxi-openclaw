import crypto from "node:crypto";
import type { CodeModeFailureCode } from "../agents/code-mode.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import type { CronTriggerEvaluationResult, CronTriggerFailureCode } from "./types.js";

// Keep the headless and Cron trigger failure contracts synchronized.
type TriggerCodesCoverHeadless = [CodeModeFailureCode | "tool_budget_exceeded"] extends [
  CronTriggerFailureCode,
]
  ? true
  : never;
const triggerCodesCoverHeadless: TriggerCodesCoverHeadless = true;
void triggerCodesCoverHeadless;

type TriggerDiagnosticContext = {
  sessionKey: string;
};

/** Owns the diagnostic lifecycle of one headless condition evaluation only. */
export function createCronTriggerDiagnosticLifecycle(jobId: string) {
  const runId = `cron-trigger:${jobId}:${crypto.randomUUID()}`;
  const trace = freezeDiagnosticTraceContext(createDiagnosticTraceContext());
  let startedAt: number | undefined;
  let sessionKey: string | undefined;
  let completed = false;
  return {
    runId,
    start(context: TriggerDiagnosticContext) {
      if (startedAt !== undefined) {
        return;
      }
      startedAt = Date.now();
      sessionKey = context.sessionKey;
      emitTrustedDiagnosticEvent({
        type: "headless.run.started",
        runId,
        sessionKey,
        trigger: "cron",
        trace,
      });
    },
    complete(result: CronTriggerEvaluationResult) {
      if (startedAt === undefined || completed) {
        return;
      }
      completed = true;
      emitTrustedDiagnosticEvent({
        type: "headless.run.completed",
        runId,
        ...(sessionKey ? { sessionKey } : {}),
        trigger: "cron",
        durationMs: Math.max(0, Date.now() - startedAt),
        outcome:
          result.kind === "error" ? "error" : result.kind === "evaluated" && result.fire ? "fired" : "not_fired",
        ...(result.kind === "error" ? { errorCategory: result.code } : {}),
        trace,
      });
    },
    run<T>(callback: () => T): T {
      return runWithDiagnosticTraceContext(trace, callback);
    },
  };
}
