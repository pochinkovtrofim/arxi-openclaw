import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { submitAction } from "./bridge.js";
import { reactionActionId } from "./outbound.js";

export const arxiActions: ChannelMessageActionAdapter = {
  describeMessageTool: () => ({ actions: ["react"], capabilities: [] }),
  handleAction: async ({ action, params }) => {
    if (action !== "react") {
      throw new Error(`Arxi action is unsupported: ${action}`);
    }
    const rawMessageId = readStringParam(params, "messageId", { required: true });
    const messageId = Number(rawMessageId);
    const emoji = readStringParam(params, "emoji", { required: true });
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || emoji.length > 32) {
      throw new Error("Arxi reaction target is invalid");
    }
    const id = reactionActionId(messageId, emoji);
    await submitAction({
      version: 2,
      action_id: id,
      kind: 4,
      payload: { message_id: messageId, emoji },
    });
    return jsonResult({ ok: true, actionId: id });
  },
};
