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

// Two earlier runs, then the current prompt with one tool round of its own.
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
const currentPromptIndex = 8;

describe("pruneEarlierRunToolResults", () => {
  it("replaces only tool results that precede the current prompt", () => {
    const { messages, pruned } = pruneEarlierRunToolResults(transcript, currentPromptIndex);

    expect(messages).toHaveLength(transcript.length);
    expect([...pruned]).toEqual(["2:a:3", "6:b:7"]);
    for (const index of [2, 6]) {
      expect(messages[index]).toMatchObject({
        role: "toolResult",
        toolCallId: transcript[index]?.role === "toolResult" ? transcript[index].toolCallId : "",
        content: [{ type: "text", text: EARLIER_RUN_TOOL_RESULT_PLACEHOLDER }],
      });
    }
    // Calls, prompts, answers and the current run's results stay as they were.
    for (const index of [0, 1, 3, 4, 5, 7, 8, 9, 10]) {
      expect(messages[index]).toBe(transcript[index]);
    }
    expect(transcript[2]).toMatchObject({ content: [{ type: "text", text: "first inbox" }] });
  });

  it("renders earlier runs identically on every request of a run", () => {
    const first = pruneEarlierRunToolResults(transcript.slice(0, 10), currentPromptIndex);
    const second = pruneEarlierRunToolResults(transcript, currentPromptIndex);

    expect(JSON.stringify(second.messages.slice(0, 10))).toBe(JSON.stringify(first.messages));
  });

  it("never reaches past the last prompt when the count is stale", () => {
    const { messages } = pruneEarlierRunToolResults(transcript, transcript.length);

    expect(messages[10]).toBe(transcript[10]);
    expect(messages[6]).toMatchObject({
      content: [{ type: "text", text: EARLIER_RUN_TOOL_RESULT_PLACEHOLDER }],
    });
  });

  it("returns the same array when there is nothing earlier to replace", () => {
    const firstRun = transcript.slice(0, 3);

    expect(pruneEarlierRunToolResults(firstRun, 0).messages).toBe(firstRun);
  });
});
