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

function receiptMany(messageIds: string[], kind: "text" | "media") {
  if (messageIds.length === 0) {
    throw new Error("Arxi outbound receipt is empty");
  }
  return {
    messageId: messageIds[0],
    visibleReplySent: true,
    receipt: createMessageReceiptFromOutboundResults({
      results: messageIds.map((messageId) => ({ channel: CHANNEL_ID, messageId })),
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
async function submitMediaAction(
  ctx: ChannelMessageSendMediaContext | ChannelMessageSendPayloadContext,
  params: { id: string; mediaUrl: string; text: string; replyToId?: string | number | null },
) {
  if (!params.mediaUrl) {
    throw new Error("Arxi media URL is required");
  }
  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: 8 * 1024 * 1024,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  });
  const name = media.fileName?.trim() || "attachment";
  const contentType = media.contentType?.trim() || "application/octet-stream";
  const uploaded = await uploadActionFile(params.id, name, contentType, media.buffer);
  await submitAction({
    version: 2,
    action_id: params.id,
    source_run_id: sourceRun(ctx.sourceRunId),
    kind: 3,
    payload: {
      caption: params.text,
      format: 1,
      name,
      media_type: contentType,
      size_bytes: uploaded.size_bytes,
      sha256: uploaded.sha256,
      media_kind: mediaKind(contentType, ctx.audioAsVoice),
      reply_to_message_id: replyId(params.replyToId ?? ctx.replyToId),
    },
  });
}

export async function sendMedia(ctx: ChannelMessageSendMediaContext) {
  owner(ctx.to);
  const id = actionId(ctx.deliveryQueueId);
  await ctx.onPlatformSendDispatch?.();
  await submitMediaAction(ctx, { id, mediaUrl: ctx.mediaUrl, text: ctx.text });
  const result = receipt(id, "media");
  await ctx.onDeliveryResult?.(result);
  return result;
}

async function sendPayloadMedia(
  ctx: ChannelMessageSendPayloadContext,
  baseId: string,
  mediaUrls: readonly string[],
) {
  if (mediaUrls.length === 0) {
    return await sendText({ ...ctx, text: ctx.payload.text ?? ctx.text });
  }
  await ctx.onPlatformSendDispatch?.();
  const ids: string[] = [];
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    const id =
      index === 0
        ? baseId
        : `media:${createHash("sha256").update(`${baseId}\0${index}`).digest("hex")}`;
    await submitMediaAction(ctx, {
      id,
      mediaUrl,
      text: index === 0 ? (ctx.payload.text ?? ctx.text) : "",
    });
    ids.push(id);
  }
  const result = receiptMany(ids, "media");
  await ctx.onDeliveryResult?.(result);
  return result;
}

async function sendPayload(ctx: ChannelMessageSendPayloadContext) {
  owner(ctx.to);
  const baseId = actionId(ctx.deliveryQueueId);
  const mediaUrls = [ctx.mediaUrl, ctx.payload.mediaUrl, ...(ctx.payload.mediaUrls ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .filter((value, index, values) => values.indexOf(value) === index);
  return await sendPayloadMedia(ctx, baseId, mediaUrls);
}

class ArxiReconciliationTopologyError extends Error {}

function effectiveReplyId(ctx: ChannelMessageUnknownSendContext) {
  if (ctx.effectiveReplyToId !== undefined) {
    return ctx.effectiveReplyToId;
  }
  return ctx.replyToMode === "off" ? undefined : ctx.replyToId;
}

function reconciliationPlan(ctx: ChannelMessageUnknownSendContext) {
  if (ctx.payloads.length !== 1 || (ctx.renderedBatchPlan?.items.length ?? 1) !== 1) {
    throw new ArxiReconciliationTopologyError(
      "Arxi reconciliation requires exactly one durable payload",
    );
  }
  const payload = ctx.payloads[0];
  const rendered = ctx.renderedBatchPlan?.items[0];
  if (!payload || (rendered && rendered.index !== 0)) {
    throw new ArxiReconciliationTopologyError("Arxi durable payload topology is invalid");
  }
  if (rendered?.hasInteractive || rendered?.hasChannelData || rendered?.presentationBlockCount) {
    throw new ArxiReconciliationTopologyError(
      "Arxi reconciliation does not support structured durable payloads",
    );
  }
  return {
    text: rendered?.text ?? payload.text ?? "",
    mediaUrls: rendered
      ? [...rendered.mediaUrls]
      : [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ),
    audioAsVoice: rendered?.audioAsVoice ?? payload.audioAsVoice,
    replyToId: effectiveReplyId(ctx),
  };
}

export async function reconcile(ctx: ChannelMessageUnknownSendContext) {
  try {
    const plan = reconciliationPlan(ctx);
    const id = actionId(ctx.queueId);
    let result;
    if (plan.mediaUrls.length > 0) {
      const sendContext = {
        ...ctx,
        payload: {
          text: plan.text,
          mediaUrls: plan.mediaUrls,
          audioAsVoice: plan.audioAsVoice,
        },
        text: plan.text,
        replyToId: plan.replyToId,
        audioAsVoice: plan.audioAsVoice,
        deliveryQueueId: id,
      };
      owner(sendContext.to);
      result = await sendPayloadMedia(sendContext, id, plan.mediaUrls);
    } else {
      result = await sendText({
        ...ctx,
        text: plan.text,
        replyToId: plan.replyToId,
        deliveryQueueId: id,
      });
    }
    return {
      status: "sent" as const,
      ...result,
    };
  } catch (error) {
    return {
      status: "unresolved" as const,
      error:
        error instanceof ArxiBridgeError && error.status === 409
          ? "Arxi action id conflicts with durable payload"
          : "Arxi action replay unavailable",
      retryable:
        error instanceof ArxiBridgeError
          ? error.status !== 409
          : !(error instanceof ArxiReconciliationTopologyError),
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
    reconcileUnknownSendKinds: { text: true, media: true, payload: true },
    reconcileUnknownSend: reconcile,
  },
  send: { text: sendText, media: sendMedia, payload: sendPayload },
});

export function reactionActionId(messageId: number, emoji: string) {
  return `reaction:${createHash("sha256").update(`${messageId}\0${emoji}`).digest("hex")}`;
}
