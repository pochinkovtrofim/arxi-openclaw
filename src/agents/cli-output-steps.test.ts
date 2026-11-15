// Verifies the parser reports Claude API-step boundaries without any content.
import { describe, expect, it } from "vitest";
import type { CliStepEvent } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

function streamEvent(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: "stream_event", event, parent_tool_use_id: null, ...extra };
}

function parseSteps(records: readonly unknown[]): CliStepEvent[] {
  const steps: CliStepEvent[] = [];
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    onStep: (event) => steps.push(event),
  });
  for (const record of records) {
    parser.push(`${JSON.stringify(record)}\n`);
  }
  parser.finish();
  return steps;
}

describe("Claude API-step events", () => {
  it("reports each message's start, first content, usage, stop and the tool results between", () => {
    const steps = parseSteps([
      streamEvent({
        type: "message_start",
        message: {
          id: "msg-1",
          usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 1 },
        },
      }),
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "secret words" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "more secret words" },
      }),
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 20 },
      }),
      streamEvent({ type: "message_stop" }),
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "secret result" }],
        },
      },
    ]);
    expect(steps).toEqual([
      {
        kind: "message_start",
        messageId: "msg-1",
        usage: { input: 10, output: 1, cacheRead: 100 },
      },
      { kind: "content" },
      { kind: "content" },
      { kind: "message_delta", usage: { output: 20 } },
      { kind: "message_stop" },
      { kind: "tool_result" },
    ]);
    expect(JSON.stringify(steps)).not.toContain("secret");
  });

  it("keeps a zero count, so a full cache miss still has complete usage", () => {
    const steps = parseSteps([
      streamEvent({
        type: "message_start",
        message: {
          id: "msg-cold",
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 158_721,
            output_tokens: 1,
          },
        },
      }),
      streamEvent({ type: "message_stop" }),
    ]);
    expect(steps[0]).toEqual({
      kind: "message_start",
      messageId: "msg-cold",
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 158_721 },
    });
  });

  it("ignores subagent records, which are not steps of the main agent", () => {
    const steps = parseSteps([
      streamEvent(
        { type: "message_start", message: { id: "sub", usage: { input_tokens: 5 } } },
        { parent_tool_use_id: "toolu_parent" },
      ),
      streamEvent({ type: "message_stop" }, { parent_tool_use_id: "toolu_parent" }),
      {
        type: "user",
        parent_tool_use_id: "toolu_parent",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
      },
    ]);
    expect(steps).toEqual([]);
  });

  it("does not feed stream-event usage into the turn usage callback", () => {
    const usages: unknown[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onUsage: (usage) => usages.push(usage),
      onStep: () => {},
    });
    parser.push(
      `${JSON.stringify(streamEvent({ type: "message_start", message: { id: "m", usage: { input_tokens: 9 } } }))}\n`,
    );
    expect(usages).toEqual([]);
  });
});
