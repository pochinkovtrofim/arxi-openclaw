import type { ResolvedPromptBuildHookResult } from "../embedded-agent-runner/run/attempt-prompt-helpers.js";
import type { RunCliAgentParams } from "./types.js";

/**
 * A day summary is a silent turn in the owner's own warm Claude process: its whole
 * conversation is read from the prompt cache only while the system prompt, tools and
 * process inputs are byte-identical to the turn before it. Rebuilding those inputs
 * from scratch would rerun the plugins' prompt hooks, which count Owner messages and
 * hand out held observations; this keeps the last person turn's inputs and the
 * system part of its hook results instead, so the silent turn changes nothing else.
 */
export type CliDaySummaryReplay = {
  params: Partial<RunCliAgentParams>;
  hookResult: ResolvedPromptBuildHookResult;
  /** When that person turn was prepared: no later than the conversation's last activity. */
  preparedAt: number;
};

// Per-turn or per-effect fields: the silent turn supplies its own, or must not borrow them.
const TURN_ONLY_KEYS = new Set<string>([
  "runId",
  "prompt",
  "transcriptPrompt",
  "imagePrompt",
  "images",
  "imageOrder",
  "media",
  "mediaImageLayout",
  "currentMessageId",
  "currentThreadTs",
  "currentInboundAudio",
  "currentInboundContext",
  "currentInboundEventKind",
  "abortSignal",
  "cliSessionBinding",
  "cliSessionId",
  "sessionEntry",
  "lifecycleGeneration",
  "expectedLifecycleRevision",
  "expectedWriterRunId",
  "forkCliSessionOnResume",
  "cliSessionResumeAt",
  "persistAssistantTranscript",
  "jobId",
  "diagnosticOwner",
  "timeoutMs",
  "runTimeoutOverrideMs",
  "contextEngineLogicalTurnLease",
  "userTurnTranscriptRecorder",
  "sessionManager",
  // Its writer fence belongs to the turn that recorded it.
  "sessionTarget",
  "admittedRunContext",
  "preparedRunAdmission",
  "operatorAuthority",
  "toolAuthorityFingerprint",
]);

const MAX_PLAIN_DEPTH = 4;
const MAX_REPLAYS = 32;
const replays = new Map<string, CliDaySummaryReplay>();

function isPlainData(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return true;
  }
  if (kind !== "object") {
    return false;
  }
  if (depth >= MAX_PLAIN_DEPTH) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isPlainData(item, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((item) =>
    isPlainData(item, depth + 1),
  );
}

// The canonical session key names its agent; callers may differ on a separate agent id.
function replayKey(params: { sessionKey?: string }): string | undefined {
  return params.sessionKey?.trim() || undefined;
}

/** Whether this prepared turn is a person's own Claude turn whose warm process a summary reuses. */
export function isCliDaySummaryReplaySource(params: RunCliAgentParams): boolean {
  return (
    params.trigger === "user" &&
    params.controlOperation === undefined &&
    params.isolatedCompletion !== true &&
    (params.executionMode ?? "agent") === "agent" &&
    params.provider === "claude-cli" &&
    params.sessionEntry?.execHost !== "node" &&
    params.disableCliLiveSession !== true &&
    replayKey(params) !== undefined
  );
}

export function rememberCliDaySummaryReplay(
  params: RunCliAgentParams,
  hookResult: ResolvedPromptBuildHookResult | undefined,
): void {
  const key = replayKey(params);
  if (!key || !isCliDaySummaryReplaySource(params)) {
    return;
  }
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    if (TURN_ONLY_KEYS.has(name) || typeof value === "function") {
      continue;
    }
    // The config is the run's own resolved snapshot; it is kept by reference, not walked.
    if (name === "config" || isPlainData(value)) {
      kept[name] = value;
    }
  }
  replays.delete(key);
  replays.set(key, {
    params: kept as Partial<RunCliAgentParams>,
    // Only the parts that shape the process: the system prompt and the tool list.
    hookResult: {
      ...(hookResult?.systemPrompt !== undefined ? { systemPrompt: hookResult.systemPrompt } : {}),
      ...(hookResult?.prependSystemContext !== undefined
        ? { prependSystemContext: hookResult.prependSystemContext }
        : {}),
      ...(hookResult?.appendSystemContext !== undefined
        ? { appendSystemContext: hookResult.appendSystemContext }
        : {}),
      ...(hookResult?.toolsAllow !== undefined ? { toolsAllow: [...hookResult.toolsAllow] } : {}),
      hasPendingNonPromptBuildContext: false,
    },
    preparedAt: Date.now(),
  });
  if (replays.size > MAX_REPLAYS) {
    const oldest = replays.keys().next().value;
    if (oldest !== undefined) {
      replays.delete(oldest);
    }
  }
}

export function readCliDaySummaryReplay(params: {
  sessionKey?: string;
}): CliDaySummaryReplay | undefined {
  const key = replayKey(params);
  return key ? replays.get(key) : undefined;
}

/** Test seam. */
export function resetCliDaySummaryReplaysForTest(): void {
  replays.clear();
}
