import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

// The Owner's own message: what Claude writes before the run's first tool call
// is published as a preamble item when that call starts, once per run.
function assistant(content: unknown[], stopReason?: string) {
  return {
    role: "assistant",
    api: "anthropic-messages",
    content,
    ...(stopReason ? { stopReason } : {}),
  };
}
const text = (value: string) => ({ type: "text", text: value });
const tool = (id: string) => ({ type: "toolCall", id, name: "web_search", arguments: {} });

async function runToolStep(
  options: { emitPreToolText?: boolean; silentExpected?: boolean },
  steps: Array<{ before: string; toolId: string }>,
) {
  const onAgentEvent = vi.fn();
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "run",
    onAgentEvent,
    ...options,
  });
  for (const step of steps) {
    emit({ type: "message_start", message: assistant([]) });
    if (step.before) {
      emit({
        type: "message_update",
        message: assistant([text(step.before)]),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: step.before },
      });
    }
    const message = assistant(
      step.before ? [text(step.before), tool(step.toolId)] : [tool(step.toolId)],
      "toolUse",
    );
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: step.before ? 1 : 0,
        partial: message,
      },
    });
    emit({ type: "message_end", message });
  }
  await subscription.waitForPendingEvents();
  subscription.unsubscribe();
  return onAgentEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.stream === "item" && event.data?.kind === "preamble");
}

describe("pre-tool preamble", () => {
  it("publishes the text before the run's first tool call", async () => {
    const items = await runToolStep({ emitPreToolText: true }, [
      { before: "Let me check your calendar.", toolId: "t1" },
      { before: "Now the weather.", toolId: "t2" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].data).toMatchObject({
      phase: "end",
      progressText: "Let me check your calendar.",
    });
  });

  it("drops reply directives and sends nothing for a silent reply", async () => {
    const [item] = await runToolStep({ emitPreToolText: true }, [
      { before: "[[reply_to_current]] Let me check.", toolId: "t1" },
    ]);
    expect(item?.data.progressText).toBe("Let me check.");
    expect(
      await runToolStep({ emitPreToolText: true }, [{ before: "NO_REPLY", toolId: "t1" }]),
    ).toHaveLength(0);
  });

  it("keeps quiet when the first tool call had no text before it", async () => {
    const items = await runToolStep({ emitPreToolText: true }, [
      { before: "", toolId: "t1" },
      { before: "Working notes between tools.", toolId: "t2" },
    ]);
    expect(items).toHaveLength(0);
  });

  it("publishes nothing for other runs or a silent one", async () => {
    const step = [{ before: "Let me check.", toolId: "t1" }];
    expect(await runToolStep({}, step)).toHaveLength(0);
    expect(await runToolStep({ emitPreToolText: true, silentExpected: true }, step)).toHaveLength(
      0,
    );
  });
});
