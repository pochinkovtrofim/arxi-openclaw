import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { hasInboundAudio } from "../../auto-reply/reply/inbound-media.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MediaFact } from "../../media/media-facts.js";

export async function applyAgentAudioUnderstanding(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  message: string;
  media: MediaFact[];
}): Promise<{ applied: boolean; message: string }> {
  const ctx: MsgContext = {
    Body: params.message,
    BodyForAgent: params.message,
    BodyForCommands: params.message,
    RawBody: params.message,
    CommandBody: params.message,
    AgentId: params.agentId,
    SessionKey: params.sessionKey,
    Provider: params.channel,
    Surface: params.channel,
    ChatType: "direct",
    media: params.media,
  };
  if (!hasInboundAudio(ctx) || params.cfg.tools?.media?.audio?.enabled === false) {
    return { applied: false, message: params.message };
  }

  const { applyMediaUnderstanding } = await import("../../media-understanding/apply.js");
  const result = await applyMediaUnderstanding({
    ctx,
    cfg: params.cfg,
    ...(params.agentId
      ? {
          agentId: params.agentId,
          agentDir: resolveAgentDir(params.cfg, params.agentId),
          workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
        }
      : {}),
    processingMode: "audio-only",
    selfServeLocalPaths: false,
  });
  const message = normalizeOptionalString(ctx.BodyForAgent ?? ctx.Body) ?? params.message;
  return { applied: result.appliedAudio, message };
}
