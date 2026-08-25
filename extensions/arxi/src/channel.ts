import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { arxiActions } from "./actions.js";
import { startArxiGateway } from "./gateway.js";
import { arxiMessageAdapter, sendMedia, sendText } from "./outbound.js";

const account = { accountId: "default", enabled: true, configured: true };

export const arxiPlugin = createChatChannelPlugin({
  base: {
    id: "arxi",
    meta: {
      id: "arxi",
      label: "Arxi",
      selectionLabel: "Arxi",
      docsPath: "/channels/arxi",
      blurb: "Private owner channel through the Arxi host boundary.",
    },
    capabilities: { chatTypes: ["direct"], media: true, reactions: true, blockStreaming: true },
    reload: { configPrefixes: ["channels.arxi"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => account,
      defaultAccountId: () => "default",
      isConfigured: () => true,
      resolveAllowFrom: () => ["owner"],
      resolveDefaultTo: () => "owner",
    },
    messaging: {
      normalizeTarget: (raw) => (raw?.trim() === "owner" ? "owner" : undefined),
      inferTargetChatType: () => "direct",
      targetResolver: { looksLikeId: (raw) => raw?.trim() === "owner", hint: "owner" },
    },
    gateway: { startAccount: startArxiGateway },
    actions: arxiActions,
    message: arxiMessageAdapter,
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: "arxi",
      sendText: async (ctx) => {
        const { onDeliveryResult: _onDeliveryResult, ...delivery } = ctx;
        const result = await sendText(delivery);
        return { messageId: result.messageId! };
      },
      sendMedia: async (ctx) => {
        if (!ctx.mediaUrl) {
          throw new Error("Arxi attached media URL is required");
        }
        const { onDeliveryResult: _onDeliveryResult, ...delivery } = ctx;
        const result = await sendMedia({ ...delivery, mediaUrl: ctx.mediaUrl });
        return { messageId: result.messageId! };
      },
    },
  },
});
