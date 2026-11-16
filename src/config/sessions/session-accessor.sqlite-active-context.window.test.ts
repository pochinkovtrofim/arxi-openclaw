import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

const sessionKey = "agent:main:main";
const sessionId = "window";
const at = new Date(1_000).toISOString();

type Boundary = { type: "reset" | "compaction"; keepFrom?: number };

/** Runs of messages, each run after the first opened by a boundary. */
function windowOfRuns(runs: number, perRun: number, boundary: (run: number) => Boundary) {
  const events: Record<string, unknown>[] = [
    { type: "session", version: 3, id: sessionId, timestamp: at, cwd: "/w" },
  ];
  let parentId: string | null = null;
  for (let run = 0; run < runs; run++) {
    if (run > 0) {
      const { type, keepFrom } = boundary(run);
      const id = `b-${run}`;
      const firstKeptEntryId = keepFrom === undefined ? undefined : `m-${run - 1}-${keepFrom}`;
      events.push(
        type === "reset"
          ? { type, id, parentId, timestamp: at, reason: "daily", firstKeptEntryId }
          : {
              type,
              id,
              parentId,
              timestamp: at,
              summary: `summary ${run}`,
              tokensBefore: 10,
              firstKeptEntryId,
            },
      );
      parentId = id;
    }
    for (let index = 0; index < perRun; index++) {
      const id = `m-${run}-${index}`;
      const role = index % 2 ? "assistant" : "user";
      events.push({
        type: "message",
        id,
        parentId,
        timestamp: at,
        message:
          role === "user"
            ? { role, content: [{ type: "text", text: id }], timestamp: 1_000 }
            : {
                role,
                content: [{ type: "text", text: id }],
                provider: "anthropic",
                model: "claude",
                api: "anthropic-messages",
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
                stopReason: "stop",
                timestamp: 1_000,
              },
      });
      parentId = id;
    }
  }
  return events;
}

describe("bounded active context from the latest boundary", () => {
  let testState: OpenClawTestState;
  let storePath: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({ prefix: "context-window-", layout: "state-only" });
    fs.mkdirSync(testState.sessionsDir(), { recursive: true });
    storePath = path.join(testState.sessionsDir(), "sessions.json");
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 10 });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  async function readBoth(events: Record<string, unknown>[]) {
    const scope = resolveSqliteReadScope({ agentId: "main", sessionKey, storePath });
    runOpenClawAgentWriteTransaction(
      (database) =>
        appendTranscriptEventsInTransaction(database, { ...scope, sessionKey, sessionId }, events),
      toDatabaseOptions(scope),
    );
    const target = { agentId: "main", sessionId, sessionKey, storePath };
    const limits = { maxBytes: 5 * 1024 * 1024, maxEvents: 10_000 };
    const whole = (await SessionManager.openBoundedAsync(target, limits)).getBranch();
    const window = (
      await SessionManager.openBoundedAsync(target, { ...limits, fromLatestBoundary: true })
    ).getBranch();
    const keepingFrom = async (keepFromEntryId: string) =>
      (
        await SessionManager.openBoundedAsync(target, {
          ...limits,
          fromLatestBoundary: true,
          keepFromEntryId,
        })
      ).getBranch();
    return { whole, window, keepingFrom };
  }

  const ids = (entries: Array<{ id: string }>) => entries.map((entry) => entry.id);
  const from = (entries: Array<{ id: string }>, id: string) =>
    ids(entries).slice(ids(entries).indexOf(id));

  it.each([
    ["a reset that keeps nothing", (): Boundary => ({ type: "reset" })],
    ["a reset that keeps a tail", (): Boundary => ({ type: "reset", keepFrom: 6 })],
    [
      "a compaction after resets",
      (run: number): Boundary =>
        run === 19 ? { type: "compaction", keepFrom: 5 } : { type: "reset" },
    ],
  ])("builds the same context from far fewer rows after %s", async (_name, boundary) => {
    const { whole, window } = await readBoth(windowOfRuns(20, 10, boundary));

    expect(buildSessionContext(window).messages).toEqual(buildSessionContext(whole).messages);
    expect(window.length).toBeLessThan(whole.length / 5);
  });

  it("keeps a compaction's summarized prefix readable: only a reset closes the window", async () => {
    const { whole, window } = await readBoth(
      windowOfRuns(20, 10, () => ({ type: "compaction", keepFrom: 7 })),
    );

    expect(window).toEqual(whole);
  });

  it("starts at the latest compaction's kept entry when the named entry is newer", async () => {
    const { whole, keepingFrom } = await readBoth(
      windowOfRuns(20, 10, () => ({ type: "compaction", keepFrom: 7 })),
    );

    const window = await keepingFrom("m-19-3");

    expect(buildSessionContext(window).messages).toEqual(buildSessionContext(whole).messages);
    expect(from(window, "m-19-3")).toEqual(from(whole, "m-19-3"));
    expect(window.length).toBeLessThan(whole.length / 10);
  });

  it("keeps every row from a named entry older than the latest compaction", async () => {
    const { whole, keepingFrom } = await readBoth(
      windowOfRuns(20, 10, () => ({ type: "compaction", keepFrom: 7 })),
    );

    const window = await keepingFrom("m-15-2");

    expect(buildSessionContext(window).messages).toEqual(buildSessionContext(whole).messages);
    expect(from(window, "m-15-2")).toEqual(from(whole, "m-15-2"));
    expect(window.length).toBeLessThan(whole.length / 3);
  });

  it("keeps the reset window for an unknown entry or one before the latest reset", async () => {
    const compactions = await readBoth(
      windowOfRuns(20, 10, () => ({ type: "compaction", keepFrom: 7 })),
    );
    expect(await compactions.keepingFrom("missing")).toEqual(compactions.window);

    const reset = await readBoth(
      windowOfRuns(20, 10, (run) =>
        run === 19 ? { type: "reset" } : { type: "compaction", keepFrom: 7 },
      ),
    );
    expect(await reset.keepingFrom("m-10-0")).toEqual(reset.window);
  });

  it("reads the same rows when there is no boundary", async () => {
    const { whole, window } = await readBoth(windowOfRuns(1, 30, () => ({ type: "reset" })));

    expect(window).toEqual(whole);
  });
});
