import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CliStepEvent } from "./cli-output-contracts.js";
import { isClaudeToolResultUserRecord, readClaudeStreamEventUsage } from "./cli-output-records.js";

/**
 * Reads one main-agent Claude stream record and reports the API-step boundary it
 * marks, if any. Only closed kinds, ids and token counts leave; never content.
 */
export function createClaudeStepObserver(onStep: (event: CliStepEvent) => void) {
  return (parsed: Record<string, unknown>): void => {
    if (isClaudeToolResultUserRecord(parsed)) {
      onStep({ kind: "tool_result" });
      return;
    }
    if (parsed.type !== "stream_event" || !isRecord(parsed.event)) {
      return;
    }
    const event = parsed.event;
    const usage = readClaudeStreamEventUsage(event);
    switch (event.type) {
      case "message_start": {
        const message = isRecord(event.message) ? event.message : undefined;
        onStep({
          kind: "message_start",
          ...(typeof message?.id === "string" ? { messageId: message.id } : {}),
          ...(usage ? { usage } : {}),
        });
        break;
      }
      case "content_block_start":
      case "content_block_delta":
        onStep({ kind: "content" });
        break;
      case "message_delta":
        onStep({ kind: "message_delta", ...(usage ? { usage } : {}) });
        break;
      case "message_stop":
        onStep({ kind: "message_stop" });
        break;
    }
  };
}
