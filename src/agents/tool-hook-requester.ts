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
 * The host-derived requester a tool hook and a plugin tool's preparation see.
 * Embedded attempts and CLI runs (through the MCP loopback) build it here, so a
 * plugin tool scoped to the requester behaves the same on either runtime. Its
 * conversation is the one the bundle MCP runtime is acquired with
 * (attempt-bundle-tools.ts), so a before_tool_call hook on an MCP tool sees the
 * conversation and sender its MCP call will carry.
 */
export function buildToolHookRequester(
  source: ToolHookRequesterSource,
): PluginHookToolRequesterContext | undefined {
  const conversationId = source.chatId ?? source.groupId ?? source.messageTo;
  const channel = source.messageChannel ?? source.messageProvider;
  const requester = {
    ...(conversationId ? { conversationId } : {}),
    ...(source.chatType ? { chatType: source.chatType } : {}),
    ...(channel ? { channel } : {}),
    ...(source.agentAccountId ? { accountId: source.agentAccountId } : {}),
    ...(source.senderId ? { senderId: source.senderId } : {}),
    ...(source.senderIsOwner !== undefined ? { senderIsOwner: source.senderIsOwner } : {}),
  } satisfies PluginHookToolRequesterContext;
  return Object.keys(requester).length > 0 ? requester : undefined;
}
