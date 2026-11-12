import type { PluginHookToolRequesterContext } from "../plugins/hook-types.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";

/** The requester a tool hook sees: conversation, channel, account and sender of the turn. */
export function buildCodingToolHookRequester(
  options: InternalCodingToolsOptions | undefined,
  turnSourceChannel: string | undefined,
): PluginHookToolRequesterContext {
  const conversationId = options?.nativeChannelId ?? options?.groupId ?? options?.messageTo;
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(options?.chatType ? { chatType: options.chatType } : {}),
    ...(turnSourceChannel ? { channel: turnSourceChannel } : {}),
    ...(options?.agentAccountId ? { accountId: options.agentAccountId } : {}),
    ...(options?.senderId ? { senderId: options.senderId } : {}),
    ...(options?.senderIsOwner !== undefined ? { senderIsOwner: options.senderIsOwner } : {}),
    ...(options?.memberRoleIds?.length ? { roleIds: [...options.memberRoleIds] } : {}),
  };
}
