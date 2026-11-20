import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  assembleCliDayCompaction,
  buildCliDaySummaryPrompt,
  CLI_DAY_CACHE_TTL_MS,
  CLI_DAY_MEMORY_PROVIDER,
  parseCliDaySummaryReply,
  planCliDayCompaction,
  resolveCliDayCompactionAheadMs,
  resolveCliDayMemoryTimeZone,
} from "../../agents/cli-runner/day-compaction.js";
import { readCliDaySummaryReplay } from "../../agents/cli-runner/day-summary-replay.js";
import { recordCliCompactionInStore } from "../../agents/command/session-store.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("auto-reply/cli-day-compaction");

// The summary turn reads the whole conversation and writes a few thousand tokens.
const CLI_DAY_SUMMARY_TIMEOUT_MS = 4 * 60_000;

// Both reads are bounded: the newest rows since the latest reset, up to this many bytes
// and events, with the latest compaction added back when it fits. A full read held a
// long chat's every tool result and image in the Gateway heap, twice across the summary
// turn, and ended an Owner's Gateway on its heap limit (2026-11-18/19). A day of
// condensed chat is far below this bound; past it, the earliest uncondensed turns are
// planned without (their rows stay in the transcript and its search).
const CLI_DAY_WINDOW_LIMITS = {
  maxBytes: 48 * 1024 * 1024,
  maxEvents: MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  fromLatestBoundary: true,
} as const;

async function openCliDayWindow(
  target: Parameters<typeof SessionManager.openBoundedAsync>[0],
  signal: AbortSignal | undefined,
): Promise<{ manager: SessionManager; truncated: boolean }> {
  let truncated = false;
  const manager = await SessionManager.openBoundedAsync(target, {
    ...CLI_DAY_WINDOW_LIMITS,
    signal,
    onTruncated: () => {
      truncated = true;
    },
  });
  return { manager, truncated };
}

/**
 * A cut window without the latest boundary would write a new one without the earlier
 * day summaries; such a conversation waits instead.
 */
function cliDayWindowLostBoundary(
  manager: SessionManager,
  branch: ReturnType<SessionManager["getBranch"]>,
): boolean {
  return (
    manager.getBoundaryCount() > 0 &&
    !branch.some((row) => row.type === "compaction" || row.type === "reset")
  );
}

/**
 * Condenses a Claude Code conversation by day. The summaries come from a silent turn in
 * the conversation's own warm process, so the conversation is read from the prompt cache;
 * OpenClaw then writes the boundary from its own transcript and drops the native session,
 * and the next turn starts a fresh one seeded with the day memory.
 *
 * Runs in the background before the cache expires (`coldCacheAhead`), or before the first
 * turn after a pause the background run missed. Returns the entry unchanged when nothing
 * is due or the step fails; the uncondensed conversation still fits its window.
 */
export async function runCliDayCompactionIfDue(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  isHeartbeat: boolean;
  coldCacheAhead?: boolean;
  onColdCacheNotDue?: (delayMs: number) => void;
  pendingUserEntryId?: string;
  abortSignal?: AbortSignal;
  assertActive: () => void;
  onCompactionStart?: () => void;
  nowMs?: number;
}): Promise<SessionEntry> {
  const { cfg, entry, sessionKey, agentId, storePath } = params;
  const binding = getCliSessionBinding(entry, CLI_DAY_MEMORY_PROVIDER);
  if (!binding || params.isHeartbeat || cfg.agents?.defaults?.compaction?.enabled === false) {
    return entry;
  }
  const nowMs = params.nowMs ?? Date.now();
  // Only a person turn in this process can be continued silently.
  const replay = readCliDaySummaryReplay({ sessionKey });
  const workspaceDir = replay?.params.workspaceDir;
  if (!replay || !workspaceDir) {
    if (params.coldCacheAhead) {
      log.info("cli day compaction skipped: no person turn in this process to continue");
    }
    return entry;
  }
  // Before a turn, a conversation whose last person turn began within the cache lifetime
  // is never condensed; the transcript read below costs a long chat's every reply time.
  if (!params.coldCacheAhead && nowMs - replay.preparedAt < CLI_DAY_CACHE_TTL_MS) {
    return entry;
  }
  const timeZone = resolveCliDayMemoryTimeZone(cfg);
  const target = { agentId, sessionId: entry.sessionId, sessionKey, storePath };
  // The plan keeps only what it needs; the session actor may cache one copy of the
  // bounded read, so a peak holds about two bounded windows, never the whole history.
  const window = await (async () => {
    const { manager, truncated } = await openCliDayWindow(target, params.abortSignal);
    const branch = manager.getBranch();
    params.assertActive();
    if (truncated && cliDayWindowLostBoundary(manager, branch)) {
      return undefined;
    }
    return {
      plannedTipId: branch.at(-1)?.id,
      plan: planCliDayCompaction({
        entries: branch,
        nowMs,
        timeZone,
        ...(params.pendingUserEntryId
          ? { excludeEntryIds: new Set([params.pendingUserEntryId]) }
          : {}),
      }),
    };
  })();
  if (!window) {
    log.warn("cli day compaction kept the conversation: its window lost the latest boundary");
    return entry;
  }
  const { plan, plannedTipId } = window;
  if (!plan.due) {
    return entry;
  }
  // The boundary keeps today from its first turn on. Before today's first turn, with no
  // message being answered, it has nothing to keep (and the transcript refuses an empty
  // anchor): the conversation is condensed after that turn instead.
  if (!plan.firstTodayEntryId && !params.pendingUserEntryId) {
    return entry;
  }
  const lastActivityMs = plan.lastActivityMs ?? entry.updatedAt ?? nowMs;
  const idleMs = nowMs - lastActivityMs;
  if (params.coldCacheAhead) {
    const aheadMs = resolveCliDayCompactionAheadMs(lastActivityMs, timeZone);
    if (idleMs < aheadMs) {
      // A guest clock stepped back can make the idle time negative; stay within one lead.
      params.onColdCacheNotDue?.(Math.min(aheadMs, Math.max(1, aheadMs - idleMs)));
      return entry;
    }
    if (idleMs >= CLI_DAY_CACHE_TTL_MS) {
      log.info(
        "cli day compaction left to the next turn: the background run woke after the cache expired",
      );
      return entry;
    }
  } else if (idleMs < CLI_DAY_CACHE_TTL_MS) {
    // A warm cache makes the next turn cheap as it is; the background run condenses it.
    return entry;
  }
  params.onCompactionStart?.();
  const startedAt = Date.now();
  const runId = `${entry.sessionId}:day-summary:${startedAt}`;
  const admission = prepareSystemAgentRunAdmission(cfg, runId, agentId, "agents.day-summary");
  let replyText: string;
  try {
    const { runCliAgent } = await import("../../agents/cli-runner.runtime.js");
    const result = await runCliAgent({
      ...replay.params,
      preparedRunAdmission: admission,
      sessionId: entry.sessionId,
      sessionKey,
      sessionFile: replay.params.sessionFile ?? sessionKey,
      workspaceDir,
      sessionEntry: entry,
      agentId: replay.params.agentId ?? agentId,
      provider: CLI_DAY_MEMORY_PROVIDER,
      prompt: buildCliDaySummaryPrompt(plan),
      runId,
      trigger: "user",
      controlOperation: "day-summary",
      cliSessionBinding: binding,
      cliSessionId: binding.sessionId,
      persistAssistantTranscript: false,
      timeoutMs: CLI_DAY_SUMMARY_TIMEOUT_MS,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    });
    replyText =
      result.meta.finalAssistantVisibleText ??
      result.payloads?.find((payload) => payload.isReasoning !== true && payload.text)?.text ??
      "";
  } catch (error) {
    params.assertActive();
    log.warn(`cli day compaction summary turn failed: ${formatErrorMessage(error)}`);
    return entry;
  } finally {
    admission.close();
  }
  params.assertActive();
  let assembled: ReturnType<typeof assembleCliDayCompaction>;
  try {
    assembled = assembleCliDayCompaction(plan, parseCliDaySummaryReply(replyText, plan));
  } catch (error) {
    log.warn(`cli day compaction kept the conversation: ${formatErrorMessage(error)}`);
    return entry;
  }

  // The boundary first: should clearing the binding fail, the next condensing redoes it.
  const { manager: writer } = await openCliDayWindow(target, params.abortSignal);
  // With no turn today, whatever arrived while the summary was written stays in context.
  const writerBranch = writer.getBranch();
  const plannedTipIndex = writerBranch.findIndex((candidate) => candidate.id === plannedTipId);
  const arrivedSinceId = plannedTipIndex >= 0 ? writerBranch[plannedTipIndex + 1]?.id : undefined;
  const pendingKeptId = writerBranch.some((candidate) => candidate.id === params.pendingUserEntryId)
    ? params.pendingUserEntryId
    : undefined;
  // The message being answered now stays too: it may be today's first.
  const firstKeptEntryId = plan.firstTodayEntryId ?? pendingKeptId ?? arrivedSinceId;
  if (!firstKeptEntryId) {
    log.warn("cli day compaction kept the conversation: nothing of today to keep yet");
    return entry;
  }
  const append = () =>
    writer.appendCompactionAsync(
      assembled.summary,
      firstKeptEntryId,
      entry.totalTokens ?? 0,
      assembled.details,
    );
  const writeTarget = writer.getSessionTarget();
  try {
    await (writeTarget
      ? withSessionTranscriptWriteAssertion(writeTarget, params.assertActive, append)
      : append());
  } catch (error) {
    params.assertActive();
    // Condensing is upkeep: a boundary that cannot be written never costs the turn.
    log.warn(`cli day compaction kept the conversation: ${formatErrorMessage(error)}`);
    return entry;
  }
  params.assertActive();
  // A rewritten shared history ends the native session; the next turn seeds a fresh one.
  const recorded = await recordCliCompactionInStore({
    agentId,
    compactionKind: "context-engine",
    sessionKey,
    sessionStore: params.sessionStore,
    storePath,
    expectedSession: entry,
  });
  log.info(
    `cli day compaction committed: days=${assembled.details.days.length} ` +
      `pastDays=${plan.pastDays.length} notes=${Object.keys(assembled.details.turnNotes).length} ` +
      `todayTurns=${plan.todayTurns.length} idleMs=${idleMs} summaryMs=${Date.now() - startedAt} ` +
      `background=${params.coldCacheAhead === true}`,
  );
  return recorded ?? entry;
}
