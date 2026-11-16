import { AsyncLocalStorage } from "node:async_hooks";
import {
  emitTrustedDiagnosticEvent,
  type PreflightStepMoment,
  type REPLY_SETTLE_STAGES,
  type RunAdmissionStep,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";

type ReplySettleStage = (typeof REPLY_SETTLE_STAGES)[number];

/**
 * Times a turn from the end of its agent run to the reply's hand-off to the channel as
 * consecutive stages: each mark closes the stage that began where the previous one ended.
 * Content-free; outside a traced turn nothing is emitted. Every event carries its own child
 * span of the turn trace, so no two records share a span id.
 */
export function createReplySettleStages(params: {
  runId?: string;
  sessionKey?: string;
  /** Closes the pre-run stages where the agent run begins, with the steps that led there. */
  onRunStarting?: (steps: ReadonlyArray<PreflightStepMoment>) => void;
}) {
  const trace = getActiveDiagnosticTraceContext();
  let stageStartedAt: number | undefined;
  let closed = false;
  let runStarted = false;
  const runSteps: PreflightStepMoment[] = [];
  return {
    /** Records that a step on the way to the agent run finished now; a repeat replaces it. */
    runStep: (step: RunAdmissionStep) => {
      if (!runStarted) {
        const index = runSteps.findIndex((recorded) => recorded.step === step);
        if (index >= 0) {
          runSteps.splice(index, 1);
        }
        runSteps.push({ step, at: Date.now() });
      }
    },
    /**
     * The run was handed to its backend: records these moments (in order) as steps without
     * closing; `runStarting` closes where the harness starts. Another run's id records nothing.
     */
    runHandedOff: (steps: ReadonlyArray<PreflightStepMoment>, runId?: string) => {
      if (
        runStarted ||
        (runId !== undefined && params.runId !== undefined && runId !== params.runId)
      ) {
        return;
      }
      for (const moment of steps) {
        const index = runSteps.findIndex((recorded) => recorded.step === moment.step);
        if (index >= 0) {
          runSteps.splice(index, 1);
        }
        runSteps.push(moment);
      }
    },
    /**
     * The agent run is about to start; the first call closes the pre-run stages with the
     * steps recorded so far, then `steps` (moments recorded elsewhere, in order). A run with
     * another id inside the turn (the pre-run memory flush) closes nothing.
     */
    runStarting: (steps: ReadonlyArray<PreflightStepMoment> = [], runId?: string) => {
      if (
        runStarted ||
        (runId !== undefined && params.runId !== undefined && runId !== params.runId)
      ) {
        return;
      }
      runStarted = true;
      params.onRunStarting?.([...runSteps, ...steps]);
    },
    /** Starts the clock where the agent run returned; a later run attempt restarts it. */
    runEnded: () => {
      stageStartedAt = Date.now();
      closed = false;
    },
    mark: (stage: ReplySettleStage) => {
      if (stageStartedAt === undefined || closed) {
        return;
      }
      const endedAt = Date.now();
      const durationMs = Math.max(0, endedAt - stageStartedAt);
      stageStartedAt = endedAt;
      if (stage === "send") {
        closed = true;
      }
      if (!trace) {
        return;
      }
      emitTrustedDiagnosticEvent({
        type: "reply.settle.stage",
        stage,
        durationMs,
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(trace)),
      });
    },
  };
}

export type ReplySettleStages = ReturnType<typeof createReplySettleStages>;

const settleStagesScope = new AsyncLocalStorage<ReplySettleStages>();

/** Binds a turn's settle stages so the run and delivery code can mark them without plumbing. */
export function runWithReplySettleStages<T>(stages: ReplySettleStages, run: () => T): T {
  return settleStagesScope.run(stages, run);
}

export function getReplySettleStages(): ReplySettleStages | undefined {
  return settleStagesScope.getStore();
}
