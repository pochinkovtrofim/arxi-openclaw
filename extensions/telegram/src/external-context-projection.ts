import { formatMediaPlaceholderText } from "openclaw/plugin-sdk/channel-inbound";
import { normalizeForwardedOrigin } from "./bot/body-helpers.js";
import {
  formatTelegramForwardedMessageBody,
  formatTelegramReplyContext,
} from "./telegram-context-rendering.js";

type ExternalReplyContext = {
  messageId: string;
  body?: string;
  quote?: string;
  sender?: { displayName?: string; id?: string; username?: string };
  mediaKind?: string;
};

type ExternalForwardItem = {
  messageId: string;
  text: string;
  forwardOrigin?: unknown;
  media?: Array<{ kind: string; disposition: "attached" | "unsupported" }>;
};

export type TelegramExternalMessageContext = {
  message: string;
  reply?: ExternalReplyContext;
  items?: ExternalForwardItem[];
};

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) {
    return undefined;
  }
  return value;
}

type TelegramMediaPlaceholderKind = "image" | "audio" | "video" | "document" | "sticker";

function telegramMediaPlaceholderKind(kind: string): TelegramMediaPlaceholderKind | undefined {
  switch (kind) {
    case "photo":
    case "image":
      return "image";
    case "voice":
    case "audio":
      return "audio";
    case "video":
    case "video_note":
    case "animation":
      return "video";
    case "document":
      return "document";
    case "sticker":
      return "sticker";
    default:
      return undefined;
  }
}

function projectForwardItem(item: ExternalForwardItem): string {
  const text = boundedString(item.text, 24 * 1024);
  const messageId = boundedString(item.messageId, 256);
  if (text === undefined || !messageId) {
    throw new Error("Telegram external forward item is invalid");
  }
  const forwarded = item.forwardOrigin ? normalizeForwardedOrigin(item.forwardOrigin) : null;
  if (item.forwardOrigin && !forwarded) {
    throw new Error("Telegram external forward origin is invalid");
  }
  const media = (item.media ?? []).map((entry) => {
    if (
      !entry ||
      typeof entry.kind !== "string" ||
      (entry.disposition !== "attached" && entry.disposition !== "unsupported")
    ) {
      throw new Error("Telegram external forward media is invalid");
    }
    if (entry.disposition === "attached") {
      const kind = telegramMediaPlaceholderKind(entry.kind);
      if (!kind) {
        throw new Error("Telegram external forward media kind is invalid");
      }
      return formatMediaPlaceholderText([{ kind }]);
    }
    return `[Unsupported Telegram ${entry.kind}: contents unavailable]`;
  });
  return [
    `[Telegram message id:${messageId}]`,
    formatTelegramForwardedMessageBody({
      body: text,
      forwardedFrom: forwarded?.from,
      forwardedDate: forwarded?.date ? forwarded.date * 1000 : undefined,
    }),
    ...media,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Projects bounded host-authenticated Telegram facts using Telegram's model-context conventions. */
export function projectTelegramExternalMessageContext(
  input: TelegramExternalMessageContext,
): string {
  const ownerMessage = boundedString(input?.message, 64 * 1024);
  if (ownerMessage === undefined || (input.items?.length ?? 0) > 12) {
    throw new Error("Telegram external message context is invalid");
  }
  const parts = (input.items ?? []).map(projectForwardItem);
  if (parts.length === 0 && ownerMessage.trim()) {
    parts.push(ownerMessage);
  }
  const reply = input.reply;
  if (reply) {
    const messageId = boundedString(reply.messageId, 256);
    if (!messageId) {
      throw new Error("Telegram external reply context is invalid");
    }
    const sender = boundedString(reply.sender?.displayName, 1024);
    const senderId = boundedString(reply.sender?.id, 256);
    const senderUsername = boundedString(reply.sender?.username, 1024);
    const selectedQuote = boundedString(reply.quote, 8 * 1024);
    const surroundingBody = boundedString(reply.body, 24 * 1024);
    const replyMediaKind = reply.mediaKind
      ? telegramMediaPlaceholderKind(boundedString(reply.mediaKind, 64) ?? "")
      : undefined;
    if (reply.mediaKind && !replyMediaKind) {
      throw new Error("Telegram external reply media kind is invalid");
    }
    parts.unshift(
      formatTelegramReplyContext([
        {
          messageId,
          sender,
          senderId: senderId === "0" ? undefined : senderId,
          senderUsername,
          selectedQuote,
          surroundingBody,
          mediaKind: replyMediaKind,
        },
      ]),
    );
  }
  return parts.join("\n\n");
}
