import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  readSessionTranscriptContextMessages,
  readSessionTranscriptModelContext,
} from "../../config/sessions/session-accessor.sqlite-model-context.js";
import { sessionTranscriptIndexNeedsReconcile } from "../../config/sessions/session-transcript-index.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

// The whole-session scan stays the reference: every read is made both ways.
const suffix = vi.hoisted(() => ({ enabled: true, wholeScans: 0, rowsRead: 0 }));

vi.mock("../../config/sessions/session-model-context-suffix.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/sessions/session-model-context-suffix.js")>();
  return {
    ...actual,
    // Every navigation row that reaches JavaScript passes here; only a scan of the
    // whole session starts at the header.
    *parseNavigationRows(...[rows]: Parameters<typeof actual.parseNavigationRows>) {
      let first = true;
      for (const row of actual.parseNavigationRows(rows)) {
        suffix.wholeScans += first && row.seq === 0 ? 1 : 0;
        suffix.rowsRead += 1;
        first = false;
        yield row;
      }
    },
    readSessionContextSuffix: (...args: Parameters<typeof actual.readSessionContextSuffix>) =>
      suffix.enabled ? actual.readSessionContextSuffix(...args) : undefined,
  };
});

const LIMITS = [
  { maxBytes: 4_000_000, maxEvents: 10_000 },
  { maxBytes: 4096, maxEvents: 4 },
];

function attempt<T>(read: () => T): T | { error: string } {
  try {
    return read();
  } catch (error) {
    return { error: String(error) };
  }
}

/** Reads the context both ways and returns how many of the bounded reads took a suffix. */
function expectSameContext(scope: SessionTranscriptRuntimeTarget): number {
  const read = () =>
    JSON.stringify({
      contexts: LIMITS.map((limits) =>
        attempt(() => readSessionTranscriptModelContext(scope, undefined, limits)),
      ),
      messages: attempt(() =>
        readSessionTranscriptContextMessages(scope, (messages, header, version) => ({
          messages: [...messages],
          header,
          version,
        })),
      ),
    });
  suffix.enabled = false;
  const whole = read();
  suffix.enabled = true;
  const before = suffix.wholeScans;
  expect(JSON.parse(read())).toStrictEqual(JSON.parse(whole));
  expect(read()).toBe(whole);
  return LIMITS.length + 1 - (suffix.wholeScans - before) / 2;
}

async function withSession(
  label: string,
  run: (scope: SessionTranscriptRuntimeTarget, source: SessionManager) => Promise<void>,
) {
  await withOpenClawTestState({ label }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: label,
      sessionKey: `agent:main:${label}`,
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await run(scope, SessionManager.open(scope));
  });
}

function turn(source: SessionManager, text: string) {
  source.appendMessage(makeUserMessage(text, 1));
  const call = `call-${text}`;
  source.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: call, name: "read", arguments: { path: `${text}.txt` } }],
      stopReason: "toolUse",
    }),
  );
  source.appendMessage({
    role: "toolResult",
    toolCallId: call,
    toolName: "read",
    content: [{ type: "text", text: `result ${text} `.repeat(40) }],
    isError: false,
    timestamp: 1,
  });
  return source.appendMessage(
    makeAgentAssistantMessage({ content: [{ type: "text", text: `answer ${text}` }] }),
  );
}

it("reads the same context from the newest boundary as from the whole session", async () => {
  await withSession("context-suffix-same", async (scope, source) => {
    const readers = LIMITS.length + 1;
    expectSameContext(scope);
    await source.appendThinkingLevelChange("high");
    await source.appendModelChange("openai", "gpt-4.1");
    turn(source, "first");
    turn(source, "second");
    expect(expectSameContext(scope)).toBe(0);

    // Straight after a reset the window holds no model or thinking state of its own.
    source.appendResetBoundary("new");
    expect(expectSameContext(scope)).toBe(readers);
    source.appendMessage(makeUserMessage("after the reset", 2));
    expect(expectSameContext(scope)).toBe(readers);
    await source.appendModelChange("anthropic", "claude-opus-5-5");
    await source.appendThinkingLevelChange("medium");
    const kept = turn(source, "third");
    turn(source, "fourth");
    expect(expectSameContext(scope)).toBe(readers);

    source.appendCompaction("summary of the third turn", kept, 100);
    expect(expectSameContext(scope)).toBe(readers);
    const retained = turn(source, "fifth");
    source.appendCustomEntry("test.note", { note: "kept out of context" });
    source.appendCustomMessageEntry("test.message", "shown to the model", false);
    expect(expectSameContext(scope)).toBe(readers);

    source.appendResetBoundary("new", retained);
    expect(expectSameContext(scope)).toBe(readers);
    const sixth = turn(source, "sixth");
    expect(expectSameContext(scope)).toBe(readers);

    // A row the tree treats as opaque keeps the whole-session scan until the next boundary.
    // It also leaves the active-path index behind, so past that boundary only the reader
    // that needs no earlier state takes the suffix.
    await appendTranscriptEvent(scope, {
      type: "opaque-synthetic",
      id: "opaque-note",
      parentId: sixth,
    });
    source.reloadPersistedTranscript();
    turn(source, "seventh");
    expect(expectSameContext(scope)).toBe(0);
    source.appendResetBoundary("reset");
    turn(source, "eighth");
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    expect(sessionTranscriptIndexNeedsReconcile(database.db, scope.sessionId)).toBe(true);
    expect(expectSameContext(scope)).toBe(1);
    await source.appendThinkingLevelChange("low");
    expect(expectSameContext(scope)).toBe(readers);
  });
});

it("reads a long session's context without its history", async () => {
  await withSession("context-suffix-long", async (scope, source) => {
    // State set once at the start stays the newest through compactions.
    await source.appendThinkingLevelChange("high");
    await source.appendModelChange("openai", "gpt-4.1");
    for (let index = 0; index < 750; index++) {
      source.appendMessage(makeUserMessage(`old message ${index}`, index));
      source.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: `old answer ${index}` }] }),
      );
    }
    const kept = source.appendMessage(makeUserMessage("kept message", 1500));
    source.appendCompaction("summary of the old messages", kept, 100);
    source.appendMessage(makeUserMessage("new message", 1501));
    expect(expectSameContext(scope)).toBe(LIMITS.length + 1);
    suffix.rowsRead = 0;
    const compacted = readSessionTranscriptModelContext(scope, undefined, LIMITS[0]);
    expect(suffix.rowsRead).toBeLessThan(10);
    expect(compacted.events.map((event) => (event as { type?: string }).type)).toEqual([
      "session",
      "thinking_level_change",
      "model_change",
      "message",
      "compaction",
      "message",
    ]);

    // After a reset the newest model state is the assistant message before it.
    source.appendMessage(makeAgentAssistantMessage({ content: [{ type: "text", text: "old" }] }));
    source.appendResetBoundary("new");
    source.appendMessage(makeUserMessage("message after the reset", 1502));
    expect(expectSameContext(scope)).toBe(LIMITS.length + 1);
    suffix.rowsRead = 0;
    const reset = readSessionTranscriptModelContext(scope, undefined, LIMITS[0]);
    expect(suffix.rowsRead).toBeLessThan(10);
    expect(reset.events.map((event) => (event as { type?: string }).type)).toEqual([
      "session",
      "thinking_level_change",
      "model_change",
      "reset",
      "message",
    ]);
  });
});
