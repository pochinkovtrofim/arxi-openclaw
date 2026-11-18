import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../sessions/session-manager.js";
import {
  assembleCliDayCompaction,
  buildCliDaySummaryPrompt,
  CLI_DAY_COMPACTION_KIND,
  parseCliDaySummaryReply,
  planCliDayCompaction,
  resolveCliDayCompactionAheadMs,
  resolveOwnerDay,
  type CliDayCompactionPlan,
} from "./day-compaction.js";
import { buildCliSessionHistoryPrompt, loadCliSessionPromptContext } from "./session-history.js";

const ZONE = "Europe/Madrid";

afterEach(() => {
  vi.useRealTimers();
});

function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

function say(manager: SessionManager, iso: string, role: "user" | "assistant", text: string) {
  at(iso);
  return manager.appendMessage(
    role === "user"
      ? { role, content: text, timestamp: Date.parse(iso) }
      : ({
          role,
          content: [{ type: "text", text }],
          api: "cli",
          provider: "claude-cli",
          model: "claude-opus-5-5",
          stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          timestamp: Date.parse(iso),
        } as never),
  );
}

function mirror(manager: SessionManager, iso: string, kind: string, text: string) {
  at(iso);
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openclaw-transcript",
    provider: "openclaw",
    model: "delivery-mirror",
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    openclawDeliveryMirror: { kind },
    timestamp: Date.parse(iso),
  } as never);
}

function plan(manager: SessionManager, nowIso: string): CliDayCompactionPlan {
  return planCliDayCompaction({
    entries: manager.getBranch(),
    nowMs: Date.parse(nowIso),
    timeZone: ZONE,
  });
}

describe("owner days", () => {
  it("start at 04:00 in the owner's zone, so a late night stays with its day", () => {
    // 02:30 Madrid on the 18th (UTC+1) still belongs to the 17th.
    expect(resolveOwnerDay(Date.parse("2026-11-18T01:30:00Z"), ZONE, 4)).toBe("2026-11-17");
    expect(resolveOwnerDay(Date.parse("2026-11-18T03:00:00Z"), ZONE, 4)).toBe("2026-11-18");
  });

  it("condenses five minutes before night sleep and three before the cache expires by day", () => {
    // Pause starts 23:50 Madrid: sleep would be possible at 00:20.
    expect(resolveCliDayCompactionAheadMs(Date.parse("2026-11-17T22:50:00Z"), ZONE)).toBe(
      25 * 60_000,
    );
    // Pause starts 14:00 Madrid.
    expect(resolveCliDayCompactionAheadMs(Date.parse("2026-11-18T13:00:00Z"), ZONE)).toBe(
      57 * 60_000,
    );
  });
});

describe("planCliDayCompaction", () => {
  it("is due for past days and for today's finished turns without notes", () => {
    const manager = SessionManager.inMemory();
    say(manager, "2026-11-16T10:00:00Z", "user", "buy milk");
    say(manager, "2026-11-16T10:01:00Z", "assistant", "added");
    say(manager, "2026-11-17T22:30:00Z", "user", "late night question");
    say(manager, "2026-11-17T22:31:00Z", "assistant", "late answer");
    const morning = say(manager, "2026-11-18T08:00:00Z", "user", "good morning");
    say(manager, "2026-11-18T08:01:00Z", "assistant", "morning!");
    const result = plan(manager, "2026-11-18T10:00:00Z");
    expect(result.today).toBe("2026-11-18");
    expect(result.pastDays.map((day) => day.date)).toEqual(["2026-11-16", "2026-11-17"]);
    expect(result.todayTurns.map((turn) => turn.id)).toEqual([morning]);
    expect(result.unnotedTurns.map((turn) => turn.id)).toEqual([morning]);
    expect(result.firstTodayEntryId).toBe(morning);
    expect(result.due).toBe(true);
  });

  it("waits while the last turn has no answer yet", () => {
    const manager = SessionManager.inMemory();
    say(manager, "2026-11-17T10:00:00Z", "user", "yesterday");
    say(manager, "2026-11-17T10:01:00Z", "assistant", "ok");
    say(manager, "2026-11-18T10:00:00Z", "user", "still thinking?");
    expect(plan(manager, "2026-11-18T10:05:00Z").due).toBe(false);
  });

  it("is not due again once today's turns have notes and no day has passed", () => {
    const manager = SessionManager.inMemory();
    const first = say(manager, "2026-11-18T08:00:00Z", "user", "check my mail");
    say(manager, "2026-11-18T08:01:00Z", "assistant", "two new letters");
    at("2026-11-18T09:00:00Z");
    manager.appendCompaction("memory", first, 1000, {
      kind: CLI_DAY_COMPACTION_KIND,
      version: 1,
      timeZone: ZONE,
      dayStartHour: 4,
      today: "2026-11-18",
      days: [],
      turnNotes: { [first]: "read Gmail inbox" },
    });
    expect(plan(manager, "2026-11-18T10:00:00Z").due).toBe(false);
    const second = say(manager, "2026-11-18T10:30:00Z", "user", "and the calendar?");
    say(manager, "2026-11-18T10:31:00Z", "assistant", "free afternoon");
    const later = plan(manager, "2026-11-18T12:00:00Z");
    expect(later.todayTurns.map((turn) => turn.id)).toEqual([first, second]);
    expect(later.unnotedTurns.map((turn) => turn.id)).toEqual([second]);
    expect(later.due).toBe(true);
  });

  it("merges days that leave the seven-day window into the earlier summary", () => {
    const manager = SessionManager.inMemory();
    const kept = say(manager, "2026-11-17T09:00:00Z", "user", "hello");
    say(manager, "2026-11-17T09:01:00Z", "assistant", "hi");
    at("2026-11-17T12:00:00Z");
    manager.appendCompaction("memory", kept, 1000, {
      kind: CLI_DAY_COMPACTION_KIND,
      version: 1,
      timeZone: ZONE,
      dayStartHour: 4,
      today: "2026-11-17",
      earlier: "Older times.",
      days: ["10", "11", "12", "13", "14", "15", "16"].map((day) => ({
        date: `2026-11-${day}`,
        summary: `Day ${day}.`,
      })),
      turnNotes: { [kept]: "" },
    });
    const result = plan(manager, "2026-11-18T10:00:00Z");
    expect(result.pastDays.map((day) => day.date)).toEqual(["2026-11-17"]);
    expect(result.overflowDates).toEqual(["2026-11-10"]);
    const prompt = buildCliDaySummaryPrompt(result);
    expect(prompt).toContain("2026-11-17, Tuesday");
    expect(prompt).toContain("Summary of 2026-11-10, Tuesday:\nDay 10.");
    expect(prompt).toContain("Older times.");
    expect(() =>
      parseCliDaySummaryReply(
        '```json\n{"days":[{"date":"2026-11-17","summary":"Greetings."}]}\n```',
        result,
      ),
    ).toThrow(/earlier summary/u);
    const reply = parseCliDaySummaryReply(
      '```json\n{"days":[{"date":"2026-11-17","summary":"Greetings."}],"earlier":"Older times and day 10."}\n```',
      result,
    );
    const { details, summary } = assembleCliDayCompaction(result, reply);
    expect(details.days.map((day) => day.date)).toEqual([
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
    ]);
    expect(details.earlier).toBe("Older times and day 10.");
    expect(details.turnNotes).toEqual({});
    expect(summary).toContain("Before 2026-11-11, Wednesday:\nOlder times and day 10.");
    expect(summary).toContain("2026-11-17, Tuesday:\nGreetings.");
  });
});

describe("parseCliDaySummaryReply", () => {
  it("fails without every requested day and maps turn notes back to entries", () => {
    const manager = SessionManager.inMemory();
    say(manager, "2026-11-17T10:00:00Z", "user", "yesterday");
    say(manager, "2026-11-17T10:01:00Z", "assistant", "ok");
    const first = say(manager, "2026-11-18T08:00:00Z", "user", "book a table");
    say(manager, "2026-11-18T08:02:00Z", "assistant", "booked for 21:00");
    const second = say(manager, "2026-11-18T09:00:00Z", "user", "thanks");
    say(manager, "2026-11-18T09:00:10Z", "assistant", "any time");
    const result = plan(manager, "2026-11-18T10:00:00Z");
    const prompt = buildCliDaySummaryPrompt(result);
    expect(prompt).toContain('- t1 (09:00): Owner: "book a table"');
    expect(prompt).toContain("Do not call any tools");
    expect(() => parseCliDaySummaryReply('{"days":[]}', result)).toThrow(/2026-11-17/u);
    const reply = parseCliDaySummaryReply(
      'Sure.\n```json\n{"days":[{"date":"2026-11-17","summary":"A quiet day."}],"turns":[{"id":"t1","note":"Booked via the restaurant site, ref 4411."}]}\n```',
      result,
    );
    expect(reply.notes).toEqual({
      [first]: "Booked via the restaurant site, ref 4411.",
      [second]: "",
    });
  });
});

describe("day memory reseed", () => {
  function condensedSession() {
    const manager = SessionManager.inMemory();
    say(manager, "2026-11-17T10:00:00Z", "user", "yesterday's words");
    say(manager, "2026-11-17T10:01:00Z", "assistant", "yesterday's answer");
    const first = say(manager, "2026-11-18T08:00:00Z", "user", "MORNING_QUESTION");
    say(manager, "2026-11-18T08:02:00Z", "assistant", "MORNING_ANSWER ".repeat(20));
    const second = say(manager, "2026-11-18T09:00:00Z", "user", "SECOND_QUESTION");
    say(manager, "2026-11-18T09:01:00Z", "assistant", "SECOND_ANSWER");
    mirror(manager, "2026-11-18T09:01:30Z", "message-tool-source-reply", "SENT_WITH_MESSAGE_TOOL");
    mirror(manager, "2026-11-18T09:01:40Z", "channel-final-suppressed", "SUPPRESSED_FINAL");
    at("2026-11-18T10:00:00Z");
    manager.appendCompaction("DAY_SUMMARIES", first, 1000, {
      kind: CLI_DAY_COMPACTION_KIND,
      version: 1,
      timeZone: ZONE,
      dayStartHour: 4,
      today: "2026-11-18",
      days: [{ date: "2026-11-17", summary: "A quiet day." }],
      turnNotes: { [first]: "Searched flights, saved MAD-BCN options", [second]: "" },
    });
    return manager;
  }

  it("keeps the summaries and today's words, with work notes in place of tool steps", async () => {
    const manager = condensedSession();
    const context = await loadCliSessionPromptContext({ sessionManager: manager });
    const prompt = buildCliSessionHistoryPrompt({
      messages: context.reseedMessages,
      prompt: "NEXT",
      maxHistoryChars: 256 * 1024,
    })!;
    expect(prompt).toContain("DAY_SUMMARIES");
    expect(prompt).toContain(
      "2026-11-18, Wednesday:\n\n[2026-11-18T08:00:00.000Z] User: MORNING_QUESTION",
    );
    expect(prompt).toContain("Assistant: SENT_WITH_MESSAGE_TOOL");
    expect(prompt).not.toContain("SUPPRESSED_FINAL");
    expect(prompt).toContain("[Work in this turn: Searched flights, saved MAD-BCN options]");
    expect(prompt).toContain("Assistant: MORNING_ANSWER");
    expect(prompt).toContain("SECOND_ANSWER");
    expect(prompt).not.toContain("yesterday's words");
    expect(prompt).toContain("<next_user_message>\nNEXT\n</next_user_message>");
  });

  it("turns the earliest of today's turns into a note when they do not fit", async () => {
    const manager = condensedSession();
    const context = await loadCliSessionPromptContext({ sessionManager: manager });
    const prompt = buildCliSessionHistoryPrompt({
      messages: context.reseedMessages,
      prompt: "NEXT",
      maxHistoryChars: 450,
    })!;
    expect(prompt).toContain("DAY_SUMMARIES");
    expect(prompt).toContain(
      'Earlier exchange (condensed): User: "MORNING_QUESTION" -> Searched flights, saved MAD-BCN options',
    );
    expect(prompt).not.toContain("Assistant: MORNING_ANSWER");
    expect(prompt).toContain("Assistant: SECOND_ANSWER");
  });

  it("shortens a long tool result in a generic reseed", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "run it" },
        { role: "toolResult", toolName: "exec", content: "x".repeat(10_000) },
      ],
      prompt: "next",
      maxHistoryChars: 256 * 1024,
    })!;
    expect(prompt).toContain("[tool result shortened]");
    expect(prompt.length).toBeLessThan(3_000);
  });
});
