import { afterEach, describe, expect, it } from "vitest";
import {
  observeCodexResponse,
  resetCodexResponseTimingsForTest,
  takeCodexResponseTiming,
} from "./inference-response-timing.js";

afterEach(() => resetCodexResponseTimingsForTest());

async function relay(
  stream: TransformStream<Uint8Array, Uint8Array>,
  chunks: Array<[number, string]>,
  clock: { now: number },
) {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const out: string[] = [];
  const decoder = new TextDecoder();
  for (const [at, text] of chunks) {
    clock.now = at;
    void writer.write(new TextEncoder().encode(text));
    const { value } = await reader.read();
    out.push(decoder.decode(value));
  }
  return out.join("");
}

describe("Codex response timing at the relay", () => {
  it("times a server-sent response split across chunks and passes every byte through", async () => {
    const clock = { now: 0 };
    const observer = observeCodexResponse(100, () => clock.now);
    const body = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","instructions":"secret"}}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel',
      'lo"}\n\nevent: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\r\n\r\n',
    ];
    const relayed = await relay(
      observer.stream(),
      [
        [150, body[0]],
        [200, body[1]],
        [700, body[2]],
        [2_100, body[3]],
      ],
      clock,
    );

    expect(relayed).toBe(body.join(""));
    expect(takeCodexResponseTiming("resp_1", 2_100)).toEqual({
      durationMs: 2_000,
      timeToFirstByteMs: 600,
    });
    expect(takeCodexResponseTiming("resp_1", 2_100)).toBeUndefined();
  });

  it("reads the event type from data when the stream names none", async () => {
    const clock = { now: 0 };
    const observer = observeCodexResponse(0, () => clock.now);
    await relay(
      observer.stream(),
      [
        [10, 'data: {"type":"response.created","response":{"id":"resp_2"}}\n\n'],
        [30, 'data: {"type":"response.reasoning_summary_text.delta","delta":"x"}\n\n'],
        [90, 'data: {"type":"response.completed","response":{"id":"resp_2"}}\n\n'],
      ],
      clock,
    );
    expect(takeCodexResponseTiming("resp_2", 90)).toEqual({
      durationMs: 90,
      timeToFirstByteMs: 30,
    });
  });

  it("times WebSocket frames and records a response with no output without a first-byte time", () => {
    let now = 5;
    const observer = observeCodexResponse(0, () => now);
    observer.frame(Buffer.from('{"type":"response.created","response":{"id":"resp_3"}}'));
    now = 50;
    observer.frame(Buffer.from('{"type":"response.incomplete","response":{"id":"resp_3"}}'));
    expect(takeCodexResponseTiming("resp_3", 50)).toEqual({ durationMs: 50 });
  });

  it("does not count metadata or rate-limit frames as the model's first output", () => {
    let now = 0;
    const observer = observeCodexResponse(0, () => now);
    now = 20;
    observer.frame(Buffer.from('{"type":"response.created","response":{"id":"resp_6"}}'));
    now = 40;
    observer.frame(Buffer.from('{"type":"codex.response.metadata","headers":{}}'));
    now = 60;
    observer.frame(Buffer.from('{"type":"codex.rate_limits","rate_limits":{}}'));
    now = 80;
    observer.frame(Buffer.from('{"type":"response.metadata","metadata":{}}'));
    now = 700;
    observer.frame(Buffer.from('{"type":"response.reasoning_summary_text.delta","delta":"x"}'));
    now = 900;
    observer.frame(Buffer.from('{"type":"response.completed","response":{"id":"resp_6"}}'));
    expect(takeCodexResponseTiming("resp_6", 900)).toEqual({ durationMs: 900, timeToFirstByteMs: 700 });
  });

  it("records nothing for an error event or a stream without a response id", () => {
    const failed = observeCodexResponse(0, () => 10);
    failed.frame(Buffer.from('{"type":"response.created","response":{"id":"resp_4"}}'));
    failed.frame(Buffer.from('{"type":"error","error":{}}'));
    failed.frame(Buffer.from('{"type":"response.completed","response":{"id":"resp_4"}}'));
    expect(takeCodexResponseTiming("resp_4", 10)).toBeUndefined();

    const anonymous = observeCodexResponse(0, () => 10);
    anonymous.frame(Buffer.from('{"type":"response.completed","response":{}}'));
    expect(takeCodexResponseTiming("", 10)).toBeUndefined();
  });

  it("forgets a timing nobody claims after ten minutes", () => {
    const observer = observeCodexResponse(0, () => 1_000);
    observer.frame(Buffer.from('{"type":"response.completed","response":{"id":"resp_5"}}'));
    expect(takeCodexResponseTiming("resp_5", 1_000 + 10 * 60_000)).toBeUndefined();
  });

  it("keeps a bounded number of unclaimed timings", () => {
    for (let index = 0; index < 600; index++) {
      observeCodexResponse(0, () => 1).frame(
        Buffer.from(`{"type":"response.completed","response":{"id":"resp_b${index}"}}`),
      );
    }
    expect(takeCodexResponseTiming("resp_b0", 1)).toBeUndefined();
    expect(takeCodexResponseTiming("resp_b599", 1)).toEqual({ durationMs: 1 });
  });
});
