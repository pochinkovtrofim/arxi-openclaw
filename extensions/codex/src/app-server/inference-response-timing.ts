import { MAX_BODY_BYTES } from "./inference-upload.js";

/**
 * Content-free timing of one Responses request, seen where it physically happens:
 * the relay. Native Codex reports a completed response (`rawResponse/completed`)
 * with its id and usage but no duration, so the relay records when the request
 * arrived, when the model's first output event came back and when the terminal
 * event came back, keyed by the upstream response id. Event types and the opaque
 * response id are read; nothing else from the stream is kept.
 */
export type CodexResponseTiming = Readonly<{
  durationMs: number;
  timeToFirstByteMs?: number;
}>;

// The completion notification follows the relayed terminal event within moments;
// a timing nobody claims (prewarm, a turn without diagnostics) ages out.
const MAX_TIMINGS = 512;
const TIMING_TTL_MS = 10 * 60_000;
const timings = new Map<string, CodexResponseTiming & { recordedAt: number }>();

// Lifecycle events native Codex gets before the model produces anything.
const PREAMBLE = new Set(["response.created", "response.in_progress", "response.queued"]);
const TERMINAL = new Set(["response.completed", "response.failed", "response.incomplete"]);
const LEADING_TYPE = /^\s*\{\s*"type"\s*:\s*"([a-z0-9_.]{1,80})"/;

function remember(responseId: string, timing: CodexResponseTiming, now: number): void {
  for (const [key, value] of timings) {
    if (timings.size < MAX_TIMINGS && now - value.recordedAt < TIMING_TTL_MS) {
      break;
    }
    timings.delete(key);
  }
  timings.delete(responseId);
  timings.set(responseId, { ...timing, recordedAt: now });
}

/** The relay's timing for one completed response, once; undefined when it saw none. */
export function takeCodexResponseTiming(
  responseId: string,
  now = Date.now(),
): CodexResponseTiming | undefined {
  const timing = timings.get(responseId);
  timings.delete(responseId);
  if (!timing || now - timing.recordedAt >= TIMING_TTL_MS) {
    return undefined;
  }
  return {
    durationMs: timing.durationMs,
    ...(timing.timeToFirstByteMs !== undefined
      ? { timeToFirstByteMs: timing.timeToFirstByteMs }
      : {}),
  };
}

export function resetCodexResponseTimingsForTest(): void {
  timings.clear();
}

/**
 * Observes the response events of one request that native Codex sent at
 * `startedAt`. Call `event` for every event before relaying it, so the timing is
 * recorded before native can report the completion.
 */
export function createCodexResponseTimingObserver(startedAt: number, now = Date.now) {
  let responseId: string | undefined;
  let firstOutputAt: number | undefined;
  let finished = false;
  // An output event counts from the moment its type is known, not when its data ends.
  const announce = (type: string) => {
    if (!finished && !PREAMBLE.has(type) && !TERMINAL.has(type) && type !== "error") {
      firstOutputAt ??= now();
    }
  };
  const event = (type: string | undefined, data: () => string | undefined) => {
    if (finished || !type) {
      return;
    }
    const at = now();
    if (type === "response.created" && responseId === undefined) {
      responseId = readResponseId(data());
      return;
    }
    if (TERMINAL.has(type)) {
      finished = true;
      responseId ??= readResponseId(data());
      if (responseId) {
        remember(
          responseId,
          {
            durationMs: Math.max(0, at - startedAt),
            ...(firstOutputAt !== undefined
              ? { timeToFirstByteMs: Math.max(0, firstOutputAt - startedAt) }
              : {}),
          },
          at,
        );
      }
      return;
    }
    if (type === "error") {
      finished = true;
      return;
    }
    if (!PREAMBLE.has(type)) {
      firstOutputAt ??= at;
    }
  };
  return {
    /** One WebSocket text frame: exactly one JSON event. */
    frame(bytes: Buffer): void {
      if (finished) {
        return;
      }
      const head = bytes.subarray(0, 256).toString("utf8");
      event(LEADING_TYPE.exec(head)?.[1] ?? readType(bytes.toString("utf8")), () =>
        bytes.toString("utf8"),
      );
    },
    /** Server-sent events: passes every chunk through unchanged. */
    stream(): TransformStream<Uint8Array, Uint8Array> {
      const decoder = new TextDecoder();
      let pending = "";
      let eventType: string | undefined;
      let data: string[] = [];
      const line = (text: string) => {
        if (text === "") {
          if (eventType !== undefined || data.length > 0) {
            const joined = data.join("\n");
            event(eventType ?? LEADING_TYPE.exec(joined)?.[1] ?? readType(joined), () => joined);
          }
          eventType = undefined;
          data = [];
        } else if (text.startsWith("event:")) {
          eventType = text.slice(6).trim();
          announce(eventType);
        } else if (text.startsWith("data:")) {
          // Only the events whose id is read keep their data; an output delta does not.
          if (
            eventType === undefined ||
            eventType === "response.created" ||
            TERMINAL.has(eventType)
          ) {
            data.push(text.slice(5).trimStart());
          }
        }
      };
      return new TransformStream({
        transform(chunk, controller) {
          if (!finished) {
            pending += decoder.decode(chunk, { stream: true });
            let newline = pending.indexOf("\n");
            while (newline >= 0 && !finished) {
              line(pending.slice(0, newline).replace(/\r$/, ""));
              pending = pending.slice(newline + 1);
              newline = pending.indexOf("\n");
            }
            if (finished || pending.length > MAX_BODY_BYTES) {
              finished = true;
              pending = "";
              data = [];
            }
          }
          controller.enqueue(chunk);
        },
      });
    },
  };
}

function readType(json: string): string | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string"
      ? (value as { type: string }).type
      : undefined;
  } catch {
    return undefined;
  }
}

function readResponseId(json: string | undefined): string | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(json);
    const response =
      value && typeof value === "object" ? (value as { response?: unknown }).response : undefined;
    const id =
      response && typeof response === "object" ? (response as { id?: unknown }).id : undefined;
    return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
  } catch {
    return undefined;
  }
}
