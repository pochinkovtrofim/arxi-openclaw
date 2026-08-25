import { describe, expect, it, vi } from "vitest";
import { dispatchArxiInbound, type StoredArxiInbound } from "./inbound.js";

function event(message: Record<string, unknown>): StoredArxiInbound {
  return {
    version: 1,
    event_id: "telegram-update:99",
    conversation_id: "telegram-chat:7",
    runtime_generation: 3,
    content_sha256: "a".repeat(64),
    telegram: { messages: [message] },
    attachments: [],
    media: [],
  };
}

async function captureDispatch(message: Record<string, unknown>) {
  let captured: Record<string, unknown> | undefined;
  const dispatch = vi.fn(async (params: Record<string, unknown>) => {
    captured = params;
    return {};
  });
  await dispatchArxiInbound({
    cfg: {} as never,
    runtime: { channel: { inbound: { dispatch } } } as never,
    event: event(message),
    lifecycle: {} as never,
  });
  if (!captured) {
    throw new Error("dispatch was not captured");
  }
  return captured as {
    ctxPayload: Record<string, unknown>;
    delivery: {
      durable: (payload: unknown, info: { kind: string }) => unknown;
      deliver: (payload: unknown, info: { kind: string }) => Promise<unknown>;
    };
  };
}

describe("Arxi typed Telegram inbound", () => {
  it("projects an ordinary reply without mislabelling it as a selected quote", async () => {
    const dispatched = await captureDispatch({
      update_id: 99,
      message_id: 10,
      sent_at_ms: 1234,
      text: "answer this",
      entities: [{ type: "bold", offset: 0, length: 6 }],
      reply: {
        message_id: 8,
        sender_id: 7,
        sender_name: "Ada Lovelace",
        sender_username: "ada",
        sender_is_bot: false,
        body: "whole parent",
      },
    });
    expect(dispatched.ctxPayload).toMatchObject({
      ReplyToId: "8",
      ReplyToBody: "whole parent",
      ReplyToSender: "Ada Lovelace",
      ReplyToIsQuote: false,
    });
    expect(dispatched.ctxPayload.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          entities: [{ type: "bold", offset: 0, length: 6 }],
          reply: expect.objectContaining({ sender_username: "ada", sender_is_bot: false }),
        }),
      }),
    ]);
  });

  it("uses selected quote text and preserves quote entities, external reply, and forward facts", async () => {
    const dispatched = await captureDispatch({
      update_id: 100,
      message_id: 11,
      text: "why?",
      reply: {
        message_id: 9,
        sender_id: 17,
        sender_name: "Grace Hopper",
        body: "whole parent",
        external: true,
        external_chat_id: -1001,
        external_chat_title: "Source",
        external_chat_username: "source",
        quote: {
          text: "selected fragment",
          position: 3,
          entities: [{ type: "italic", offset: 0, length: 8 }],
        },
      },
      forward: {
        type: "user",
        sender_id: 18,
        sender_name: "Forwarded User",
        sender_username: "forwarded",
        sender_is_bot: true,
        sent_at_ms: 999,
      },
    });
    expect(dispatched.ctxPayload).toMatchObject({
      ReplyToBody: "selected fragment",
      ReplyToIsQuote: true,
      ForwardedFrom: "Forwarded User",
      ForwardedFromId: "18",
      ForwardedFromType: "user",
      ForwardedDate: 999,
    });
    expect(dispatched.ctxPayload.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          reply: expect.objectContaining({
            external_chat_title: "Source",
            quote: expect.objectContaining({
              position: 3,
              entities: [{ type: "italic", offset: 0, length: 8 }],
            }),
          }),
          forward: expect.objectContaining({ sender_is_bot: true }),
        }),
      }),
    ]);
  });

  it("requires OpenClaw durable-final delivery and has no direct final fallback", async () => {
    const dispatched = await captureDispatch({ update_id: 101, message_id: 12, text: "hello" });
    expect(dispatched.delivery.durable({}, { kind: "final" })).toEqual({ to: "owner" });
    expect(dispatched.delivery.durable({}, { kind: "block" })).toBe(false);
    await expect(dispatched.delivery.deliver({}, { kind: "final" })).rejects.toThrow(
      /durable final delivery is unavailable/,
    );
    await expect(dispatched.delivery.deliver({}, { kind: "block" })).resolves.toEqual({
      visibleReplySent: false,
    });
  });
});
