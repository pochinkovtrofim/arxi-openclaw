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
          : { type, id, parentId, timestamp: at, summary: `summary ${run}`, tokensBefore: 10, firstKeptEntryId },
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
    return { whole, window };
  }

  it.each([
    ["a reset that keeps nothing", (): Boundary => ({ type: "reset" })],
    ["a reset that keeps a tail", (): Boundary => ({ type: "reset", keepFrom: 6 })],
    ["a compaction that keeps a tail", (): Boundary => ({ type: "compaction", keepFrom: 7 })],
    [
      "a compaction after resets",
      (run: number): Boundary => (run === 19 ? { type: "compaction", keepFrom: 5 } : { type: "reset" }),
    ],
  ])("builds the same context from far fewer rows after %s", async (_name, boundary) => {
    const { whole, window } = await readBoth(windowOfRuns(20, 10, boundary));

    expect(buildSessionContext(window).messages).toEqual(buildSessionContext(whole).messages);
    expect(window.length).toBeLessThan(whole.length / 5);
  });

  it("reads the same rows when there is no boundary", async () => {
    const { whole, window } = await readBoth(windowOfRuns(1, 30, () => ({ type: "reset" })));

    expect(window).toEqual(whole);
  });
});
