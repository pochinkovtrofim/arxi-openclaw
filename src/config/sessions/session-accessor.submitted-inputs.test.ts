import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  listSessionPendingInputs,
  readSessionExternalInputReceipt,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("submitted input read boundaries", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-");
  const sessionKey = "agent:main:pending-inputs";
  const sessionId = "pending-session";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const message = (runId: string, content = "Continue the task"): PersistedUserTurnMessage => ({
    role: "user",
    content,
    timestamp: 100,
    idempotencyKey: `${runId}:user`,
  });
  const stage = async (
    runId: string,
    options: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
  ) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId,
      message: message(runId),
      assertCurrent: () => {},
      ...options,
    });
    if (receipt) {
      receipts.push(receipt);
    }
    return receipt!;
  };
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message }));
  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });

  it("does not create missing storage for a submitted-input lookup", () => {
    const storePath = path.join(fixture.sessionsDir(), "missing-agent.sqlite");
    expect(readSessionSubmittedInput({ ...scope(), storePath }, "missing:user")).toBeUndefined();
    expect(
      readSessionExternalInputReceipt(
        { ...scope(), storePath },
        "external:missing:user",
        "external:missing",
      ),
    ).toEqual({ status: "uncertain" });
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it.each(["pending", "committed"] as const)(
    "rejects malformed or oversized %s source bytes without changing storage",
    async (source) => {
      const receipt = await stage("invalid-source");
      if (source === "committed") {
        await promote(receipt);
      }
      const db = database().db;
      const invalidMessages = [
        "{",
        JSON.stringify({ ...receipt.message, role: "assistant" }),
        JSON.stringify({ ...receipt.message, idempotencyKey: "another:user" }),
        JSON.stringify(message("invalid-source", "💥".repeat(MAX_PAYLOAD_BYTES / 4))),
      ];
      for (const messageJson of invalidMessages) {
        if (source === "pending") {
          db.prepare("UPDATE session_pending_inputs SET message_json = ? WHERE input_id = ?").run(
            messageJson,
            receipt.inputId,
          );
        } else {
          db.prepare(
            "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
          ).run(`{"message":${messageJson}}`, sessionId, sessionId, receipt.inputId);
        }
        db.exec("PRAGMA query_only = ON");
        try {
          expect(readSessionSubmittedInput(scope(), "invalid-source:user")).toBeUndefined();
        } finally {
          db.exec("PRAGMA query_only = OFF");
        }
      }
    },
  );

  it.each(["dirty", "missing", "lagging"] as const)(
    "does not read or repair a %s transcript identity projection",
    async (projection) => {
      const receipt = await stage("stale-source");
      await promote(receipt);
      const db = database().db;
      if (projection === "missing") {
        db.prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?").run(
          sessionId,
        );
      } else {
        const statement =
          projection === "dirty"
            ? "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?"
            : "UPDATE session_transcript_index_state SET indexed_seq = -1 WHERE session_id = ?";
        db.prepare(statement).run(sessionId);
      }
      const before = db
        .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
        .get(sessionId);
      db.exec("PRAGMA query_only = ON");
      try {
        expect(readSessionSubmittedInput(scope(), "stale-source:user")).toBeUndefined();
      } finally {
        db.exec("PRAGMA query_only = OFF");
      }
      expect(
        db
          .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
          .get(sessionId),
      ).toEqual(before);
    },
  );

  it("bounds materialized pending pages by bytes without truncating input or skipping its cursor", async () => {
    const content = "x".repeat(Math.floor(MAX_PAYLOAD_BYTES / 2));
    const first = await stage("large-first", { message: message("large-first", content) });
    const second = await stage("large-second", { message: message("large-second", content) });
    const page = listSessionPendingInputs(scope());
    expect(page.items.map((input) => input.id)).toEqual([second.inputId]);
    expect(page.items[0]?.message.content === content).toBe(true);
    expect(page.total).toBe(2);
    expect(page.nextBefore).toBeDefined();
    const older = listSessionPendingInputs(scope(), { before: page.nextBefore });
    expect(older.items.map((input) => input.id)).toEqual([first.inputId]);
    expect(older.items[0]?.message.content === content).toBe(true);
    expect(older.nextBefore).toBeUndefined();
  });
});
