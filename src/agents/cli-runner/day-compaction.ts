import { iterateSessionContextEntries } from "../../../packages/agent-core/src/harness/session/session.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import type { SessionEntry as StoredSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import { resolveUserTimezone } from "../date-time.js";
import type { SessionEntry } from "../sessions/session-manager.js";

/**
 * Day memory for a conversation that runs through a native CLI session (Claude Code).
 * Today stays verbatim; each finished owner day becomes one dated summary, the last
 * `separateDays` days separately and older ones merged into one. Work inside a turn
 * (tool calls, results, reasoning) lives only in the native session, so it is replaced
 * by a one-line note the model writes about its own turn. A day starts at
 * `dayStartHour` in the Owner's time zone, so a late evening stays with its day.
 */
export const CLI_DAY_COMPACTION_KIND = "openclaw.cli-days";
export const DEFAULT_CLI_DAY_START_HOUR = 4;
export const DEFAULT_CLI_SEPARATE_DAYS = 7;

export type CliDaySummary = { date: string; summary: string };

export type CliDayCompactionDetails = {
  kind: typeof CLI_DAY_COMPACTION_KIND;
  version: 1;
  timeZone: string;
  dayStartHour: number;
  /** The Owner day whose turns stay verbatim after this boundary. */
  today: string;
  /** Days older than the separate window, merged. */
  earlier?: string;
  /** Oldest first. */
  days: CliDaySummary[];
  /** User-turn entry id to its work note; empty means the turn used no tools. */
  turnNotes: Record<string, string>;
};

export type CliDayTurn = {
  /** Transcript entry id of the turn's first message (the user message when there is one). */
  id: string;
  startMs: number;
  day: string;
  userText: string;
  /** An internal trigger (background run), not the Owner's own words. */
  internal: boolean;
  assistantTexts: string[];
  finished: boolean;
};

export type CliDayCompactionPlan = {
  today: string;
  timeZone: string;
  dayStartHour: number;
  previous?: CliDayCompactionDetails;
  /** A summary from another compaction kind, folded into the earlier summary. */
  legacySummary?: string;
  /** Past days with turns in the live context, oldest first. */
  pastDays: { date: string; turns: CliDayTurn[] }[];
  /** Dates (past or already summarized) that leave the separate window now. */
  overflowDates: string[];
  todayTurns: CliDayTurn[];
  /** Today's finished turns that have no note yet. */
  unnotedTurns: CliDayTurn[];
  /** First entry of today's turns, kept verbatim after the boundary. */
  firstTodayEntryId?: string;
  lastActivityMs?: number;
  due: boolean;
};

export function isCliDayCompactionDetails(value: unknown): value is CliDayCompactionDetails {
  if (!value || typeof value !== "object") {
    return false;
  }
  const details = value as Partial<CliDayCompactionDetails>;
  return (
    details.kind === CLI_DAY_COMPACTION_KIND &&
    typeof details.today === "string" &&
    Array.isArray(details.days) &&
    typeof details.turnNotes === "object" &&
    details.turnNotes !== null
  );
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The Owner day (YYYY-MM-DD) an instant belongs to: its local date `dayStartHour` hours earlier. */
export function resolveOwnerDay(ms: number, timeZone: string, dayStartHour: number): string {
  return dateFormatter(timeZone).format(new Date(ms - dayStartHour * 3_600_000));
}

/** Local hour of day (0-23) in a time zone. */
export function resolveLocalHour(ms: number, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms))
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0);
}

export function formatOwnerDayLabel(date: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
  return `${date}, ${weekday}`;
}

function formatLocalTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

/** Visible text of a message; images become a marker so the turn still says one was there. */
export function readCliDayMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (typeof text === "string" && text.trim()) {
      parts.push(text.trim());
    } else if (type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n").trim();
}

function entryMs(entry: SessionEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Ro's words as the Owner saw them. A reply sent through the message tool, or a message
 * a background run delivered, exists only as a transcript-only row; other such rows
 * (slash-command replies, suppressed finals, notices) were never Ro speaking.
 */
function isCliDayVisibleAssistantRow(message: unknown): boolean {
  if (!isTranscriptOnlyOpenClawAssistantMessage(message)) {
    return true;
  }
  const row = message as { model?: unknown; openclawDeliveryMirror?: { kind?: unknown } };
  return (
    row.model === "gateway-injected" ||
    row.openclawDeliveryMirror?.kind === "message-tool-source-reply"
  );
}

/** Turns of the current context window, in order; each starts at a user message. */
export function collectCliDayTurns(
  entries: readonly SessionEntry[],
  params: { timeZone: string; dayStartHour: number; excludeEntryIds?: ReadonlySet<string> },
): CliDayTurn[] {
  const turns: CliDayTurn[] = [];
  let current: CliDayTurn | undefined;
  for (const { entry } of iterateSessionContextEntries(entries)) {
    if (entry.type !== "message" || params.excludeEntryIds?.has(entry.id)) {
      continue;
    }
    const message = entry.message as { role?: unknown; content?: unknown; provenance?: unknown };
    if (message.role === "user") {
      const startMs = entryMs(entry);
      const provenance = normalizeInputProvenance(message.provenance);
      current = {
        id: entry.id,
        startMs,
        day: resolveOwnerDay(startMs, params.timeZone, params.dayStartHour),
        userText: readCliDayMessageText(message.content),
        internal: provenance?.kind === "internal_system",
        assistantTexts: [],
        finished: false,
      };
      turns.push(current);
      continue;
    }
    if (message.role !== "assistant" || !isCliDayVisibleAssistantRow(entry.message)) {
      continue;
    }
    const text = readCliDayMessageText(message.content);
    if (!current) {
      // A message Ro sent on her own before any request in this window.
      const startMs = entryMs(entry);
      current = {
        id: entry.id,
        startMs,
        day: resolveOwnerDay(startMs, params.timeZone, params.dayStartHour),
        userText: "",
        internal: true,
        assistantTexts: [],
        finished: false,
      };
      turns.push(current);
    }
    // A mirror may repeat the reply it records.
    if (text && !current.assistantTexts.includes(text)) {
      current.assistantTexts.push(text);
    }
    current.finished = true;
  }
  return turns;
}

export function planCliDayCompaction(params: {
  entries: readonly SessionEntry[];
  nowMs: number;
  timeZone: string;
  dayStartHour?: number;
  separateDays?: number;
  excludeEntryIds?: ReadonlySet<string>;
}): CliDayCompactionPlan {
  const dayStartHour = params.dayStartHour ?? DEFAULT_CLI_DAY_START_HOUR;
  const separateDays = params.separateDays ?? DEFAULT_CLI_SEPARATE_DAYS;
  const { timeZone } = params;
  const today = resolveOwnerDay(params.nowMs, timeZone, dayStartHour);
  const boundary = params.entries.findLast(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  const boundaryDetails = boundary?.type === "compaction" ? boundary.details : undefined;
  const previous = isCliDayCompactionDetails(boundaryDetails) ? boundaryDetails : undefined;
  const legacySummary =
    boundary?.type === "compaction" && !previous && boundary.summary.trim()
      ? boundary.summary.trim()
      : undefined;
  const turns = collectCliDayTurns(params.entries, {
    timeZone,
    dayStartHour,
    excludeEntryIds: params.excludeEntryIds,
  });
  const byDay = new Map<string, CliDayTurn[]>();
  for (const turn of turns) {
    if (turn.day < today) {
      byDay.set(turn.day, [...(byDay.get(turn.day) ?? []), turn]);
    }
  }
  const pastDays = [...byDay.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([date, dayTurns]) => ({ date, turns: dayTurns }));
  const todayTurns = turns.filter((turn) => turn.day >= today);
  const notes = previous?.turnNotes ?? {};
  const unnotedTurns = todayTurns.filter((turn) => turn.finished && !(turn.id in notes));
  const allDates = [
    ...new Set([...(previous?.days ?? []).map((day) => day.date), ...pastDays.map((d) => d.date)]),
  ].toSorted();
  const overflowDates = allDates.slice(0, Math.max(0, allDates.length - separateDays));
  const lastTurn = turns.at(-1);
  const lastActivityMs = params.entries.reduce<number | undefined>((latest, entry) => {
    if (entry.type !== "message" || params.excludeEntryIds?.has(entry.id)) {
      return latest;
    }
    const ms = entryMs(entry);
    return latest === undefined || ms > latest ? ms : latest;
  }, undefined);
  return {
    today,
    timeZone,
    dayStartHour,
    ...(previous ? { previous } : {}),
    ...(legacySummary ? { legacySummary } : {}),
    pastDays,
    overflowDates,
    todayTurns,
    unnotedTurns,
    ...(todayTurns[0] ? { firstTodayEntryId: todayTurns[0].id } : {}),
    ...(lastActivityMs !== undefined ? { lastActivityMs } : {}),
    // A turn still waiting for its answer is never condensed under it.
    due:
      (lastTurn === undefined || lastTurn.finished) &&
      (pastDays.length > 0 || unnotedTurns.length > 0 || legacySummary !== undefined),
  };
}

const MAX_PROMPT_QUOTE_CHARS = 160;

/** The merged summary is rewritten only when days leave the window or an old summary joins it. */
function cliDayReplyNeedsEarlier(plan: CliDayCompactionPlan): boolean {
  return plan.overflowDates.length > 0 || plan.legacySummary !== undefined;
}

function quote(text: string): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length > MAX_PROMPT_QUOTE_CHARS
    ? `${single.slice(0, MAX_PROMPT_QUOTE_CHARS)}…`
    : single;
}

/** Short ids the model answers with, mapped back to transcript entry ids. */
export function resolveCliDayTurnKeys(plan: CliDayCompactionPlan): Map<string, CliDayTurn> {
  return new Map(plan.unnotedTurns.map((turn, index) => [`t${index + 1}`, turn]));
}

/** The silent turn's request. Model-facing text is English; summaries follow the chat's language. */
export function buildCliDaySummaryPrompt(plan: CliDayCompactionPlan): string {
  const overflow = new Set(plan.overflowDates);
  const separateDates = plan.pastDays.map((day) => day.date).filter((date) => !overflow.has(date));
  const mergedPastDates = plan.pastDays.map((day) => day.date).filter((date) => overflow.has(date));
  const mergedSummaries = (plan.previous?.days ?? []).filter((day) => overflow.has(day.date));
  const earlierSources = [
    ...(plan.previous?.earlier
      ? [`Current summary of earlier days:\n${plan.previous.earlier}`]
      : []),
    ...(plan.legacySummary ? [`Older condensed history:\n${plan.legacySummary}`] : []),
    ...mergedSummaries.map((day) => `Summary of ${formatOwnerDayLabel(day.date)}:\n${day.summary}`),
  ];
  const needsEarlier = cliDayReplyNeedsEarlier(plan);
  const keys = resolveCliDayTurnKeys(plan);
  const lines: string[] = [
    "[Memory upkeep from OpenClaw, not from the Owner. Nobody sees this message or your answer. Do not call any tools and do not address the Owner; answer only with the JSON object described below.]",
    "",
    `This conversation is about to be condensed. Afterwards today's messages stay word for word; each earlier day is kept only as your summary, and the work inside each of today's turns (tool calls, their results, your reasoning) only as your note. Write in the language you and the Owner use. Days are the Owner's: they run from ${String(plan.dayStartHour).padStart(2, "0")}:00 to ${String(plan.dayStartHour).padStart(2, "0")}:00, time zone ${plan.timeZone}.`,
  ];
  if (separateDates.length > 0) {
    lines.push(
      "",
      "1. `days`: one summary for each of these days, from what this conversation holds for it:",
      ...separateDates.map((date) => `- ${formatOwnerDayLabel(date)}`),
      "Cover what the Owner asked and told you, what you did and how it ended, decisions, promises and anything still open, with the names, places, numbers, dates and links that matter. Include the distinctive words someone would search for to find the exact messages later. 80-300 words a day.",
    );
  }
  if (needsEarlier) {
    lines.push(
      "",
      "2. `earlier`: one merged summary, at most 500 words, of everything older than the separate days. Combine:",
      ...earlierSources.map((source) => `<<<\n${source}\n>>>`),
      ...(mergedPastDates.length > 0
        ? [
            `and these days from this conversation: ${mergedPastDates.map(formatOwnerDayLabel).join("; ")}.`,
          ]
        : []),
      "Keep what still matters: standing facts about the Owner, open commitments, recurring people and places, decisions that still hold.",
    );
  }
  if (keys.size > 0) {
    lines.push(
      "",
      "3. `turns`: for each of today's turns below, one line on the work you did inside it: what you looked up, changed or sent with tools and how it ended, with any file, link or id needed to continue. An empty string when you used no tools.",
      ...[...keys.entries()].map(
        ([key, turn]) =>
          `- ${key} (${formatLocalTime(turn.startMs, plan.timeZone)}): ${
            turn.userText
              ? `${turn.internal ? "background run" : "Owner"}: "${quote(turn.userText)}"`
              : `your own message: "${quote(turn.assistantTexts[0] ?? "")}"`
          }`,
      ),
    );
  }
  lines.push(
    "",
    "Answer with exactly one JSON object in a ```json block, using only the keys asked for above:",
    '{"days":[{"date":"YYYY-MM-DD","summary":"..."}],"earlier":"...","turns":[{"id":"t1","note":"..."}]}',
  );
  return lines.join("\n");
}

export type CliDaySummaryReply = {
  days: CliDaySummary[];
  earlier?: string;
  notes: Record<string, string>;
};

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("day summary reply has no JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Validates the silent turn's answer against the plan; a missing day fails the whole step. */
export function parseCliDaySummaryReply(
  text: string,
  plan: CliDayCompactionPlan,
): CliDaySummaryReply {
  const parsed = extractJsonObject(text) as {
    days?: unknown;
    earlier?: unknown;
    turns?: unknown;
  };
  const overflow = new Set(plan.overflowDates);
  const wantedDays = plan.pastDays.map((day) => day.date).filter((date) => !overflow.has(date));
  const daysByDate = new Map<string, string>();
  for (const day of Array.isArray(parsed.days) ? parsed.days : []) {
    const { date, summary } = (day ?? {}) as { date?: unknown; summary?: unknown };
    if (typeof date === "string" && typeof summary === "string" && summary.trim()) {
      daysByDate.set(date.trim(), summary.trim());
    }
  }
  const missing = wantedDays.filter((date) => !daysByDate.has(date));
  if (missing.length > 0) {
    throw new Error(`day summary reply misses ${missing.join(", ")}`);
  }
  const earlier = typeof parsed.earlier === "string" ? parsed.earlier.trim() : "";
  if (cliDayReplyNeedsEarlier(plan) && !earlier) {
    throw new Error("day summary reply misses the earlier summary");
  }
  const keys = resolveCliDayTurnKeys(plan);
  const notes: Record<string, string> = {};
  for (const item of Array.isArray(parsed.turns) ? parsed.turns : []) {
    const { id, note } = (item ?? {}) as { id?: unknown; note?: unknown };
    const turn = typeof id === "string" ? keys.get(id.trim()) : undefined;
    if (turn && typeof note === "string") {
      notes[turn.id] = note.replace(/\s+/gu, " ").trim();
    }
  }
  // A turn the model left out keeps no note rather than holding the whole step back.
  for (const turn of keys.values()) {
    notes[turn.id] ??= "";
  }
  return {
    days: wantedDays.map((date) => ({ date, summary: daysByDate.get(date) ?? "" })),
    ...(earlier ? { earlier } : {}),
    notes,
  };
}

/** Folds the reply into the next boundary's details and its readable summary. */
export function assembleCliDayCompaction(
  plan: CliDayCompactionPlan,
  reply: CliDaySummaryReply,
): { details: CliDayCompactionDetails; summary: string } {
  const overflow = new Set(plan.overflowDates);
  const days = new Map<string, string>();
  for (const day of plan.previous?.days ?? []) {
    if (!overflow.has(day.date)) {
      days.set(day.date, day.summary);
    }
  }
  for (const day of reply.days) {
    days.set(day.date, day.summary);
  }
  const todayIds = new Set(plan.todayTurns.map((turn) => turn.id));
  const turnNotes: Record<string, string> = {};
  for (const [id, note] of Object.entries(plan.previous?.turnNotes ?? {})) {
    if (todayIds.has(id)) {
      turnNotes[id] = note;
    }
  }
  Object.assign(turnNotes, reply.notes);
  const earlier = reply.earlier ?? plan.previous?.earlier;
  const details: CliDayCompactionDetails = {
    kind: CLI_DAY_COMPACTION_KIND,
    version: 1,
    timeZone: plan.timeZone,
    dayStartHour: plan.dayStartHour,
    today: plan.today,
    ...(earlier ? { earlier } : {}),
    days: [...days.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([date, summary]) => ({ date, summary })),
    turnNotes,
  };
  return { details, summary: renderCliDayCompactionSummary(details) };
}

export function renderCliDayCompactionSummary(details: CliDayCompactionDetails): string {
  const hour = `${String(details.dayStartHour).padStart(2, "0")}:00`;
  const sections = [
    `Conversation memory by day (time zone ${details.timeZone}; a day runs from ${hour} to ${hour}). Earlier days are kept as summaries; their exact messages are not in this context, so search the conversation history when the exact wording matters.`,
  ];
  if (details.earlier) {
    sections.push(
      `Before ${details.days[0] ? formatOwnerDayLabel(details.days[0].date) : details.today}:\n${details.earlier}`,
    );
  }
  for (const day of details.days) {
    sections.push(`${formatOwnerDayLabel(day.date)}:\n${day.summary}`);
  }
  return sections.join("\n\n");
}

/** Anthropic's long prompt-cache lifetime, the one the CLI conversation is written with. */
export const CLI_DAY_CACHE_TTL_MS = 60 * 60_000;
// Background day compaction runs this long into a pause, before the cache expires.
const CLI_DAY_AHEAD_MS = CLI_DAY_CACHE_TTL_MS - 3 * 60_000;
// The host may sleep a quiet VM after 30 minutes in the Owner's night, 00:00 to 08:00
// (its `sleep.*` defaults). The VM cannot see those settings, so it plans with the
// defaults: a pause that would reach sleep is condensed five minutes before it.
const CLI_DAY_NIGHT_START_HOUR = 0;
const CLI_DAY_NIGHT_END_HOUR = 8;
const CLI_DAY_IDLE_SLEEP_MS = 30 * 60_000;
const CLI_DAY_SLEEP_LEAD_MS = 5 * 60_000;

/** How long into a pause that started at `lastActivityMs` the background run condenses. */
export function resolveCliDayCompactionAheadMs(lastActivityMs: number, timeZone: string): number {
  const hour = resolveLocalHour(lastActivityMs + CLI_DAY_IDLE_SLEEP_MS, timeZone);
  const nightSleepPossible =
    CLI_DAY_NIGHT_START_HOUR <= CLI_DAY_NIGHT_END_HOUR
      ? hour >= CLI_DAY_NIGHT_START_HOUR && hour < CLI_DAY_NIGHT_END_HOUR
      : hour >= CLI_DAY_NIGHT_START_HOUR || hour < CLI_DAY_NIGHT_END_HOUR;
  return nightSleepPossible ? CLI_DAY_IDLE_SLEEP_MS - CLI_DAY_SLEEP_LEAD_MS : CLI_DAY_AHEAD_MS;
}

export const CLI_DAY_MEMORY_PROVIDER = "claude-cli";

/** Day memory belongs to a conversation that runs through a resumable Claude Code session. */
export function usesCliDayMemory(entry: StoredSessionEntry | undefined): boolean {
  return getCliSessionBinding(entry, CLI_DAY_MEMORY_PROVIDER) !== undefined;
}

export function resolveCliDayMemoryTimeZone(cfg: OpenClawConfig): string {
  return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
}

/** Background maintenance arms its run this long after a person's turn ends. */
export function resolveCliDayMemoryAheadMs(cfg: OpenClawConfig, nowMs = Date.now()): number {
  return resolveCliDayCompactionAheadMs(nowMs, resolveCliDayMemoryTimeZone(cfg));
}
