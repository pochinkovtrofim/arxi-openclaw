import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createRunPrepStageReporter } from "../../infra/run-prep-stages.js";
import { takeHookPhaseTimings } from "../../plugins/hook-phase-timing.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import { summarizeSessionContext } from "../embedded-agent-runner/run/attempt-context-summary.js";
import type { AgentMessage } from "../runtime/index.js";
import type { PreparedCliRunContext } from "./types.js";

/** Closed name of the last checkpoint, from the final preparation step to the hand-off. */
export const CLI_PREP_HANDOFF_STAGE = "execution-setup";

export type CliPrepStages = {
  /** Records the time since the previous checkpoint under a closed stage name. */
  mark: (stage: string) => void;
  /**
   * Hands the request to the CLI execution: reports the hook timings and the
   * contiguous stages once for the run. Later calls (a retry) report nothing.
   */
  handOff: (input: { context: PreparedCliRunContext; historyMessages: readonly unknown[] }) => void;
};

/**
 * Times a CLI turn from its start to the point its request is handed to the
 * CLI execution, so the work trace shows where the time before the model went.
 * It reports through the shared stage reporter the embedded runner uses.
 */
export function createCliPrepStages(params: {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
}): CliPrepStages {
  const tracker = createStageTimingTracker();
  const runTrace = freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope());
  const report = createRunPrepStageReporter({
    tracker,
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    runTrace,
    finalStage: CLI_PREP_HANDOFF_STAGE,
  });
  let handedOff = false;
  return {
    mark: (stage) => tracker.mark(stage),
    handOff: ({ context, historyMessages }) => {
      if (handedOff) {
        return;
      }
      handedOff = true;
      const run = context.params;
      const hookTimings = takeHookPhaseTimings(run.runId);
      const summary = summarizeSessionContext(
        historyMessages.filter(
          (message): message is AgentMessage => typeof message === "object" && message !== null,
        ),
      );
      const channel = run.messageChannel ?? run.messageProvider;
      const event: DiagnosticEventInput = {
        type: "context.assembled",
        runId: run.runId,
        ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        provider: run.provider,
        model: context.modelId,
        ...(channel ? { channel } : {}),
        ...(run.trigger ? { trigger: run.trigger } : {}),
        messageCount: historyMessages.length,
        historyTextChars: summary.totalTextChars,
        historyImageBlocks: summary.totalImageBlocks,
        maxMessageTextChars: summary.maxMessageTextChars,
        systemPromptChars: context.systemPrompt.length,
        promptChars: run.prompt.length,
        promptImages: run.images?.length ?? 0,
        ...(context.contextWindowInfo?.tokens
          ? { contextTokenBudget: context.contextWindowInfo.tokens }
          : {}),
        ...(hookTimings.before_prompt_build
          ? { promptHooks: hookTimings.before_prompt_build }
          : {}),
        ...(hookTimings.before_agent_run ? { agentRunHooks: hookTimings.before_agent_run } : {}),
        trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(runTrace)),
      };
      emitTrustedDiagnosticEvent(event);
      report();
    },
  };
}
