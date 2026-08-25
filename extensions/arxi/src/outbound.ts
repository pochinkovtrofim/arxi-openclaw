import { createHash } from "node:crypto";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendMediaContext,
  type ChannelMessageSendPayloadContext,
  type ChannelMessageSendTextContext,
  type ChannelMessageUnknownSendContext,
} from "openclaw/plugin-sdk/channel-outbound";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { ArxiBridgeError, submitAction, uploadActionFile } from "./bridge.js";

const CHANNEL_ID = "arxi";
function owner(to: string) {
  if (to.trim() !== "owner") {
    throw new Error("Arxi channel accepts only owner target");
  }
}
function actionId(value?: string) {
  if (!value || value.length > 256) {
    throw new Error("Arxi durable delivery id is required");
  }
  return value;
}
function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
function sourceRun(value?: string) {
  if (value === undefined) {
    return undefined;
  }
  if (!value || value.length > 256 || hasControlCharacter(value)) {
    throw new Error("Arxi source run id is invalid");
  }
  return value;
}
function replyId(value?: string | number | null) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function receipt(messageId: string, kind: "text" | "media") {
  return {
    messageId,
    visibleReplySent: true,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: CHANNEL_ID, messageId }],
      kind,
    }),
  };
}

export async function sendText(ctx: ChannelMessageSendTextContext) {
  owner(ctx.to);
  const id = actionId(ctx.deliveryQueueId);
  await ctx.onPlatformSendDispatch?.();
  await submitAction({
    version: 2,
    action_id: id,
    source_run_id: sourceRun(ctx.sourceRunId),
    kind: 1,
    payload: { text: ctx.text, format: 1, reply_to_message_id: replyId(ctx.replyToId) },
  });
  const result = receipt(id, "text");
  await ctx.onDeliveryResult?.(result);
  return result;
}

function mediaKind(contentType: string, audioAsVoice?: boolean) {
  if (audioAsVoice) {
    return 5;
  }
  if (contentType === "image/gif") {
    return 3;
  }
  if (contentType.startsWith("image/")) {
    return 1;
  }
  if (contentType.startsWith("video/")) {
    return 2;
  }
  if (contentType.startsWith("audio/")) {
    return 4;
  }
  return 6;
}
export async function sendMedia(ctx: ChannelMessageSendMediaContext) {
  owner(ctx.to);
  const id = actionId(ctx.deliveryQueueId);
  if (!ctx.mediaUrl) {
    throw new Error("Arxi media URL is required");
  }
  const media = await loadOutboundMediaFromUrl(ctx.mediaUrl, {
    maxBytes: 8 * 1024 * 1024,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  });
  const name = media.fileName?.trim() || "attachment";
  const contentType = media.contentType?.trim() || "application/octet-stream";
  await ctx.onPlatformSendDispatch?.();
  const uploaded = await uploadActionFile(id, name, contentType, media.buffer);
  await submitAction({
    version: 2,
    action_id: id,
    source_run_id: sourceRun(ctx.sourceRunId),
    kind: 3,
    payload: {
      caption: ctx.text,
      format: 1,
      name,
      media_type: contentType,
      size_bytes: uploaded.size_bytes,
      sha256: uploaded.sha256,
      media_kind: mediaKind(contentType, ctx.audioAsVoice),
      reply_to_message_id: replyId(ctx.replyToId),
    },
  });
  const result = receipt(id, "media");
  await ctx.onDeliveryResult?.(result);
  return result;
}

async function sendPayload(ctx: ChannelMessageSendPayloadContext) {
  const mediaUrl = ctx.mediaUrl ?? ctx.payload.mediaUrl ?? ctx.payload.mediaUrls?.[0];
  return mediaUrl
    ? await sendMedia({ ...ctx, mediaUrl })
    : await sendText({ ...ctx, text: ctx.payload.text ?? ctx.text });
}

async function reconcile(ctx: ChannelMessageUnknownSendContext) {
  try {
    const payload = ctx.payloads?.[0];
    if (!payload) {
      throw new Error("missing payload");
    }
    const id = actionId(ctx.queueId);
    const text = payload.text ?? "";
    if (payload.mediaUrl) {
      await sendMedia({
        ...ctx,
        mediaUrl: payload.mediaUrl,
        text,
        deliveryQueueId: id,
      });
    } else {
      await sendText({ ...ctx, text, deliveryQueueId: id });
    }
    return {
      status: "sent" as const,
      ...receipt(id, payload.mediaUrl ? "media" : "text"),
    };
  } catch (error) {
    return {
      status: "unresolved" as const,
      error:
        error instanceof ArxiBridgeError && error.status === 409
          ? "Arxi action id conflicts with durable payload"
          : "Arxi action replay unavailable",
      retryable: !(error instanceof ArxiBridgeError && error.status === 409),
    };
  }
}

export const arxiMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      payload: true,
      replyTo: true,
      messageSendingHooks: true,
      reconcileUnknownSend: true,
    },
    automaticUnknownSendReconciliation: true,
    reconcileUnknownSendKinds: { text: true, media: true },
    reconcileUnknownSend: reconcile,
  },
  send: { text: sendText, media: sendMedia, payload: sendPayload },
});

export function reactionActionId(messageId: number, emoji: string) {
  return `reaction:${createHash("sha256").update(`${messageId}\0${emoji}`).digest("hex")}`;
}
