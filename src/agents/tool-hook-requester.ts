import type { PluginHookToolRequesterContext } from "../plugins/hook-requester-context.types.js";

/** Run facts a tool hook's requester is built from, shared by every runtime. */
export type ToolHookRequesterSource = {
  chatId?: string;
  groupId?: string | null;
  /** The reply target, when the runtime keeps it apart from chatId. */
  messageTo?: string;
  chatType?: string;
  senderId?: string | null;
  senderIsOwner?: boolean;
  agentAccountId?: string;
  messageChannel?: string;
  messageProvider?: string;
};

/**
 * Who a turn acts for and in which conversation. A tool hook's requester and
 * the turn's bundle MCP acquisition both take it from here, on every runtime,
 * so an MCP call carries the conversation and sender its before_tool_call hook
 * saw: a plugin that binds an approval to the hook's conversation finds the
 * same one on the call it approved.
 */
export function resolveToolHookRequesterIdentity(source: ToolHookRequesterSource): {
  conversationId?: string;
  chatType?: string;
  senderId?: string;
} {
  const conversationId = source.chatId ?? source.groupId ?? source.messageTo;
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(source.chatType ? { chatType: source.chatType } : {}),
    ...(source.senderId ? { senderId: source.senderId } : {}),
  };
}

/**
 * The host-derived requester a tool hook and a plugin tool's preparation see.
 * Embedded attempts and CLI runs (through the MCP loopback) build it here, so a
 * plugin tool scoped to the requester behaves the same on either runtime.
 */
export function buildToolHookRequester(
  source: ToolHookRequesterSource,
): PluginHookToolRequesterContext | undefined {
  const { conversationId, chatType, senderId } = resolveToolHookRequesterIdentity(source);
  const channel = source.messageChannel ?? source.messageProvider;
  const requester = {
    ...(conversationId ? { conversationId } : {}),
    ...(chatType ? { chatType } : {}),
    ...(channel ? { channel } : {}),
    ...(source.agentAccountId ? { accountId: source.agentAccountId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(source.senderIsOwner !== undefined ? { senderIsOwner: source.senderIsOwner } : {}),
  } satisfies PluginHookToolRequesterContext;
  return Object.keys(requester).length > 0 ? requester : undefined;
}
