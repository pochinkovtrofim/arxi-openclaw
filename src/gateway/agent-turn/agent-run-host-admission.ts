import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapabilityLifetime,
} from "../message-action-turn-capability.js";

/**
 * A trusted local host names the private Owner message a direct turn answers.
 * Like channel ingress, that turn may act on its current conversation (for
 * example react to the message): the run context gets the conversation and a
 * current-turn action capability. The caller revokes it when the turn ends.
 */
export function admitHostCurrentConversationActions(
  runContext: {
    senderId?: string | null;
    currentChannelId?: string;
    messageActionTurnCapability?: string;
  },
  params: {
    cfg: OpenClawConfig;
    directOwnerReply?: boolean;
    admittedMessageId?: string;
    agentId?: string;
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    delivery: { resolvedChannel?: string; resolvedTo?: string; resolvedAccountId?: string };
    timeoutSeconds?: number;
  },
): string | undefined {
  const messageId = params.admittedMessageId?.trim();
  const { resolvedChannel, resolvedTo } = params.delivery;
  if (
    !params.directOwnerReply ||
    !messageId ||
    !params.agentId ||
    !params.sessionKey ||
    !resolvedChannel ||
    !resolvedTo
  ) {
    return undefined;
  }
  // Delivery falls back to the channel default account; the action must match it.
  const plugin = getChannelPlugin(normalizeChannelId(resolvedChannel) ?? resolvedChannel);
  const accountId =
    params.delivery.resolvedAccountId ??
    (plugin?.config?.listAccountIds
      ? resolveChannelDefaultAccountId({ plugin, cfg: params.cfg })
      : undefined);
  const capability = mintMessageActionTurnCapability({
    agentId: params.agentId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    sourceReplySessionKey: params.sessionKey,
    sessionId: params.sessionId,
    requesterAccountId: accountId,
    requesterSenderId: runContext.senderId ?? undefined,
    toolContext: {
      currentChannelProvider: resolvedChannel,
      currentChannelId: resolvedTo,
      currentMessagingTarget: resolvedTo,
      currentChatType: "direct",
      currentMessageId: messageId,
    },
    ...resolveMessageActionTurnCapabilityLifetime((params.timeoutSeconds ?? 0) * 1000),
  });
  runContext.messageActionTurnCapability = capability;
  runContext.currentChannelId ??= resolvedTo;
  return capability;
}
