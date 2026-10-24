import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  EARLIER_RUN_TOOL_RESULT_PLACEHOLDER,
  pruneEarlierRunToolResults,
} from "./tool-result-truncation.js";

function user(text: string, timestamp: number): AgentMessage {
  return castAgentMessage({ role: "user", content: [{ type: "text", text }], timestamp });
}

function toolCall(id: string, timestamp: number): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: { path: "inbox.md" } }],
    stopReason: "toolUse",
    timestamp,
  });
}

function toolResult(id: string, text: string, timestamp: number): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  });
}

function answer(text: string, timestamp: number): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
  });
}

// Two earlier runs, then the current run (started at 9) with one tool round of its own.
const transcript = [
  user("check 1", 1),
  toolCall("a", 2),
  toolResult("a", "first inbox", 3),
  answer("nothing new", 4),
  user("check 2", 5),
  toolCall("b", 6),
  toolResult("b", "second inbox", 7),
  answer("one reply drafted", 8),
  user("check 3", 9),
  toolCall("c", 10),
  toolResult("c", "third inbox", 11),
];
const runStartedAt = 9;
const placeholder = [{ type: "text", text: EARLIER_RUN_TOOL_RESULT_PLACEHOLDER }];

describe("pruneEarlierRunToolResults", () => {
  it("replaces only tool results recorded before the run started", () => {
    const { messages, pruned } = pruneEarlierRunToolResults(transcript, runStartedAt);

    expect(messages).toHaveLength(transcript.length);
    expect([...pruned]).toEqual(["a:3", "b:7"]);
    expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "a", content: placeholder });
    expect(messages[6]).toMatchObject({ role: "toolResult", toolCallId: "b", content: placeholder });
    // Calls, prompts, answers and the current run's results stay as they were.
    for (const index of [0, 1, 3, 4, 5, 7, 8, 9, 10]) {
      expect(messages[index]).toBe(transcript[index]);
    }
    expect(transcript[2]).toMatchObject({ content: [{ type: "text", text: "first inbox" }] });
  });

  it("renders earlier runs identically on every request of a run", () => {
    const first = pruneEarlierRunToolResults(transcript.slice(0, 10), runStartedAt);
    const second = pruneEarlierRunToolResults(transcript, runStartedAt);

    expect(JSON.stringify(second.messages.slice(0, 10))).toBe(JSON.stringify(first.messages));
  });

  it("keeps the run's own results on a retry attempt after a new prompt", () => {
    const retry = [...transcript, user("Continue from where you stopped.", 12)];
    const { messages } = pruneEarlierRunToolResults(retry, runStartedAt);

    expect(messages[10]).toBe(retry[10]);
    expect(messages[6]).toMatchObject({ content: placeholder });
  });

  it("returns the same array when there is nothing earlier to replace", () => {
    const firstRun = transcript.slice(0, 3);

    expect(pruneEarlierRunToolResults(firstRun, 1).messages).toBe(firstRun);
  });
});
