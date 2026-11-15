import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntry } from "./session-accessor.js";
import type { SessionResetBoundaryWrite } from "./session-accessor.lifecycle-types.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { appendSessionResetBoundary } from "./session-accessor.sqlite-reset-boundary.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";

const sessionKey = "agent:main:cron:steward";
const sessionId = "steward-window";

function message(id: string, parentId: string | null, role: "user" | "assistant") {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(1_000).toISOString(),
    message: { role, content: [{ type: "text", text: id }], timestamp: 1_000 },
  };
}

/** A window that reset in place once per run: runs of messages, each opened by a boundary. */
function windowOfRuns(runs: number, perRun: number, keepTail: boolean) {
  const events: Record<string, unknown>[] = [
    { type: "session", version: 3, id: sessionId, timestamp: new Date(1).toISOString(), cwd: "/w" },
  ];
  let parentId: string | null = null;
  let runStart: string | undefined;
  for (let run = 0; run < runs; run++) {
    if (run > 0) {
      const id = `reset-${run}`;
      events.push({
        type: "reset",
        id,
        parentId,
        timestamp: new Date(1_000).toISOString(),
        reason: "cron-stale",
        ...(keepTail && runStart ? { firstKeptEntryId: runStart } : {}),
      });
      parentId = id;
    }
    for (let index = 0; index < perRun; index++) {
      const id = `m-${run}-${index}`;
      runStart = index === perRun - 2 ? id : runStart;
      events.push(message(id, parentId, index % 2 ? "assistant" : "user"));
      parentId = id;
    }
  }
  return events;
}

describe("SQLite reset boundary", () => {
  let testState: OpenClawTestState;
  let storePath: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-reset-boundary-",
      layout: "state-only",
    });
    fs.mkdirSync(testState.sessionsDir(), { recursive: true });
    storePath = path.join(testState.sessionsDir(), "sessions.json");
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 10 });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  function seedAndReset(events: Record<string, unknown>[], boundary: SessionResetBoundaryWrite) {
    const scope = resolveSqliteReadScope({ agentId: "main", sessionKey, storePath });
    const options = toDatabaseOptions(scope);
    runOpenClawAgentWriteTransaction(
      (database) =>
        appendTranscriptEventsInTransaction(database, { ...scope, sessionKey, sessionId }, events),
      options,
    );
    return runOpenClawAgentWriteTransaction((database) => {
      const before = loadTranscriptEventsFromDatabase(database, sessionId, {
        projection: "reset-boundary",
      });
      const tracked = trackSqliteStatementExecutions(database.db, ["transcript"], (sql) =>
        /from "transcript_events"/i.test(sql) ? "transcript" : null,
      );
      try {
        appendSessionResetBoundary(
          database,
          { ...scope, sessionKey, sessionId },
          { sessionId, updatedAt: 10 },
          boundary,
        );
      } finally {
        tracked.restore();
      }
      const after = loadTranscriptEventsFromDatabase(database, sessionId);
      return {
        expected: buildSessionResetBoundaryEvent({ events: before, ...boundary }),
        appended: after.at(-1) as Record<string, unknown>,
        transcriptRowsRead: tracked.rowCounts.transcript,
      };
    }, options);
  }

  it("reads the latest boundary window, not the history, for a clear reset", () => {
    const { expected, appended, transcriptRowsRead } = seedAndReset(windowOfRuns(200, 10, false), {
      context: "clear",
      reason: "cron-stale",
    });

    expect(appended).toMatchObject({ type: "reset", parentId: expected.parentId });
    expect(appended.parentId).toBe("m-199-9");
    expect(appended.firstKeptEntryId).toBeUndefined();
    // One run of 2,200 rows: the boundary and its ten messages (plus the header check).
    expect(transcriptRowsRead).toBeLessThan(20);
  });

  it("keeps the same replay tail as a whole-transcript read", () => {
    const { expected, appended, transcriptRowsRead } = seedAndReset(windowOfRuns(50, 10, true), {
      context: "preserve-tail",
      reason: "daily",
    });

    expect(expected.firstKeptEntryId).toBeDefined();
    expect(appended).toMatchObject({
      type: "reset",
      parentId: expected.parentId,
      firstKeptEntryId: expected.firstKeptEntryId,
    });
    expect(transcriptRowsRead).toBeLessThan(30);
  });

  it("reads the whole transcript when a branch leaf controls the active path", () => {
    const events = windowOfRuns(20, 10, false);
    events.push({
      type: "leaf",
      id: "leaf-1",
      parentId: "m-19-9",
      leafId: "m-10-3",
      timestamp: new Date(1_000).toISOString(),
    });
    const { expected, appended, transcriptRowsRead } = seedAndReset(events, {
      context: "clear",
      reason: "new",
    });

    expect(appended).toMatchObject({ type: "reset", parentId: expected.parentId });
    expect(transcriptRowsRead).toBeGreaterThanOrEqual(events.length);
  });
});
