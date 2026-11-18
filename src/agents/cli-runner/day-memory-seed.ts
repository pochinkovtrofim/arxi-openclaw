import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionEntry } from "../sessions/session-manager.js";
import {
  collectCliDayTurns,
  formatOwnerDayLabel,
  isCliDayCompactionDetails,
  type CliDayTurn,
} from "./day-compaction.js";

// Day memory after compaction: summaries plus today's words stay near 40k tokens.
const MAX_CLI_DAY_SEED_HISTORY_CHARS = 110_000;
const CLI_DAY_CONDENSED_QUOTE_CHARS = 240;

type CliDaySeedTurn = CliDayTurn & { role: "cliDayTurn"; note?: string };

function isCliDaySeedTurn(message: unknown): message is CliDaySeedTurn {
  return Boolean(message) && (message as { role?: unknown }).role === "cliDayTurn";
}

/**
 * After a day compaction a fresh session gets the day summaries and every turn since
 * the boundary's kept start, with each turn's work note; the turn being answered now is
 * its prompt, not history.
 */
export function resolveCliDayMemoryReseed(
  entries: SessionEntry[],
  currentUserEntryId: string | undefined,
): unknown[] | undefined {
  const boundary = entries.findLast(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  if (boundary?.type !== "compaction" || !isCliDayCompactionDetails(boundary.details)) {
    return undefined;
  }
  const details = boundary.details;
  const turns = collectCliDayTurns(entries, {
    timeZone: details.timeZone,
    dayStartHour: details.dayStartHour,
    ...(currentUserEntryId ? { excludeEntryIds: new Set([currentUserEntryId]) } : {}),
  });
  const seedTurns = turns.map((turn) => {
    const note = details.turnNotes[turn.id];
    return Object.assign(turn, { role: "cliDayTurn" as const }, note ? { note } : {});
  });
  return [
    {
      role: "compactionSummary",
      summary: boundary.summary.trim(),
      timestamp: boundary.timestamp,
      cliDays: true,
    },
    ...seedTurns,
  ];
}

function condenseQuote(text: string): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length > CLI_DAY_CONDENSED_QUOTE_CHARS
    ? `${truncateUtf16Safe(single, CLI_DAY_CONDENSED_QUOTE_CHARS).trimEnd()}…`
    : single;
}

function renderCliDayTurn(turn: CliDaySeedTurn, condensed: boolean): string {
  const time = timestampMsToIsoString(turn.startMs);
  const prefix = time ? `[${time}] ` : "";
  const asker = turn.internal ? "Background run" : "User";
  if (condensed) {
    const outcome = turn.note || turn.assistantTexts.at(-1) || "";
    return `${prefix}Earlier exchange (condensed): ${
      turn.userText ? `${asker}: "${condenseQuote(turn.userText)}"` : "Assistant wrote first"
    }${outcome ? ` -> ${condenseQuote(outcome)}` : ""}`;
  }
  return [
    ...(turn.userText ? [`${prefix}${asker}: ${turn.userText}`] : []),
    ...(turn.note ? [`[Work in this turn: ${turn.note}]`] : []),
    ...turn.assistantTexts.map(
      (text, index) => `${index === 0 && !turn.userText ? prefix : ""}Assistant: ${text}`,
    ),
  ].join("\n");
}

/** Each owner day of the kept turns opens with its date, so yesterday never reads as today. */
function joinByDay(turns: CliDaySeedTurn[], rendered: string[]): string {
  const parts: string[] = [];
  let day: string | undefined;
  rendered.forEach((text, index) => {
    if (!text) {
      return;
    }
    const turnDay = turns[index]!.day;
    if (turnDay !== day) {
      day = turnDay;
      parts.push(`${formatOwnerDayLabel(turnDay)}:`);
    }
    parts.push(text);
  });
  return parts.join("\n\n");
}

/**
 * Day memory: the summaries are never cut, and the kept turns stay word for word. Only
 * when they do not fit does the earliest kept turn become its one-line note.
 * Undefined when the history is not day memory.
 */
export function renderCliDayMemoryHistory(
  messages: unknown[],
  maxHistoryChars: number,
): string | undefined {
  const head = messages[0] as { role?: unknown; summary?: unknown; cliDays?: unknown } | undefined;
  if (head?.role !== "compactionSummary" || head.cliDays !== true) {
    return undefined;
  }
  const summary = typeof head.summary === "string" ? head.summary.trim() : "";
  const turns = messages.slice(1).filter(isCliDaySeedTurn);
  const budget = Math.min(maxHistoryChars, MAX_CLI_DAY_SEED_HISTORY_CHARS);
  const rendered = turns.map((turn) => renderCliDayTurn(turn, false));
  // Room for the omission notice, should it come to that.
  const total = () => summary.length + 80 + joinByDay(turns, rendered).length;
  let condensed = 0;
  while (total() > budget && condensed < turns.length - 1) {
    rendered[condensed] = renderCliDayTurn(turns[condensed]!, true);
    condensed += 1;
  }
  let omitted = 0;
  while (total() > budget && omitted < condensed) {
    rendered[omitted] = "";
    omitted += 1;
  }
  const kept = joinByDay(turns, rendered);
  const omission =
    omitted > 0
      ? `[${omitted} earlier exchanges omitted; search the conversation history for them.]\n\n`
      : "";
  return [summary, `${omission}${kept}`].filter((part) => part.trim()).join("\n\n");
}
