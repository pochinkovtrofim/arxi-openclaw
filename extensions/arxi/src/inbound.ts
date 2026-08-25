import {
  buildChannelInboundEventContext,
  resolveChannelInboundRouteEnvelope,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { ArxiInboundEvent } from "./bridge.js";
import { readInboundFile } from "./bridge.js";

export type StoredArxiInbound = ArxiInboundEvent & {
  media: Array<{ path: string; contentType?: string }>;
};

export async function prepareArxiInbound(event: ArxiInboundEvent): Promise<StoredArxiInbound> {
  if (
    event.version !== 1 ||
    !event.event_id ||
    !event.conversation_id ||
    !Number.isSafeInteger(event.runtime_generation) ||
    event.runtime_generation <= 0 ||
    !Array.isArray(event.telegram?.messages) ||
    event.telegram.messages.length === 0 ||
    !Array.isArray(event.attachments)
  ) {
    throw new Error("Arxi inbound event is invalid");
  }
  const media: Array<{ path: string; contentType?: string }> = [];
  for (const attachment of event.attachments) {
    const content = await readInboundFile(attachment);
    const saved = await saveMediaBuffer(
      content,
      attachment.media_type,
      "inbound",
      undefined,
      attachment.name,
    );
    media.push({ path: saved.path, contentType: saved.contentType ?? attachment.media_type });
  }
  return { ...event, media };
}

function messageText(message: Record<string, unknown>): string {
  return typeof message.text === "string" ? message.text : "";
}
function messageNumber(message: Record<string, unknown>, field: string): number | undefined {
  const value = message[field];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function dispatchArxiInbound(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  event: StoredArxiInbound;
  lifecycle: ChannelIngressMonitorLifecycle;
}) {
  const messages = params.event.telegram.messages ?? [];
  const text = messages
    .map(messageText)
    .filter((value) => value.trim())
    .join("\n\n");
  const first = messages[0] ?? {};
  const messageId = String(messageNumber(first, "message_id") ?? params.event.event_id);
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: params.cfg,
    channel: "arxi",
    accountId: "default",
    peer: { kind: "direct", id: "owner" },
  });
  const body = buildEnvelope({
    channel: "Arxi",
    from: "Owner",
    timestamp: messageNumber(first, "sent_at_ms"),
    body: text,
  });
  const media = await toInboundMediaFactsWithMetadata(params.event.media);
  const reply = objectRecord(first.reply) ? first.reply : undefined;
  const forward = objectRecord(first.forward) ? first.forward : undefined;
  const quote = reply && objectRecord(reply.quote) ? reply.quote : undefined;
  const structured = messages.map((message) => ({
    label: "Telegram message context",
    payload: {
      update_id: message.update_id,
      message_id: message.message_id,
      entities: message.entities,
      reply: message.reply,
      forward: message.forward,
      context: message.context,
      attachment_ids: message.attachment_ids,
    },
  }));
  const ctxPayload = buildChannelInboundEventContext({
    channel: "arxi",
    accountId: route.accountId ?? "default",
    messageId,
    messageIdFull: messageId,
    timestamp: messageNumber(first, "sent_at_ms"),
    from: "arxi:owner",
    sender: { id: "owner", name: "Owner" },
    conversation: { kind: "direct", id: params.event.conversation_id, label: "Owner" },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: {
      to: "owner",
      originatingTo: "owner",
      replyToId:
        reply && typeof reply.message_id === "number" ? String(reply.message_id) : undefined,
    },
    message: { body, bodyForAgent: text, rawBody: text, commandBody: text },
    media,
    channelIngress: "unsupported",
    access: {
      commands: { authorized: true },
      mentions: { canDetectMention: false, wasMentioned: false },
    },
    supplemental: {
      quote: reply
        ? {
            id: typeof reply.message_id === "number" ? String(reply.message_id) : "",
            body:
              typeof quote?.text === "string"
                ? quote.text
                : typeof reply.body === "string"
                  ? reply.body
                  : undefined,
            sender: typeof reply.sender_name === "string" ? reply.sender_name : undefined,
            isExternal: reply.external === true,
            isQuote: quote !== undefined,
          }
        : undefined,
      forwarded: forward
        ? {
            from: typeof forward.sender_name === "string" ? forward.sender_name : undefined,
            fromId: typeof forward.sender_id === "number" ? String(forward.sender_id) : undefined,
            fromType: typeof forward.type === "string" ? forward.type : undefined,
            date: typeof forward.sent_at_ms === "number" ? forward.sent_at_ms : undefined,
          }
        : undefined,
      channelStructuredContext: structured,
    } satisfies NonNullable<Parameters<typeof buildChannelInboundEventContext>[0]["supplemental"]>,
  });
  await params.runtime.channel.inbound.dispatch({
    cfg: params.cfg,
    channel: "arxi",
    accountId: "default",
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      durable: (_payload, info) => (info.kind === "final" ? { to: "owner" } : false),
      deliver: async (_payload, info) => {
        if (info.kind === "final") {
          throw new Error("Arxi durable final delivery is unavailable");
        }
        return { visibleReplySent: false };
      },
      onError: (error: unknown) => {
        throw error;
      },
    },
    replyPipeline: {},
    replyOptions: bindIngressLifecycleToReplyOptions(params.lifecycle),
  });
}
