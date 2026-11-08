import { createHash } from "node:crypto";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "@openclaw/ai/providers";
import { truncateCodePoints } from "@openclaw/normalization-core/code-points";

export function resolveSessionBoundaryPromptCacheKey(params: {
  api: string;
  boundaryCount: number;
  promptCacheKey?: string;
  sessionId: string;
  agentId?: string;
  modelId?: string;
}): string | undefined {
  const explicit = params.promptCacheKey?.trim();
  if (explicit) {
    return explicit;
  }
  if (!params.api.includes("openai")) {
    return undefined;
  }
  // The ChatGPT subscription backend routes its prompt cache by this key, so a
  // per-session key made every background run pay for the agent's shared tools
  // and instructions again, even minutes after another run. One key per agent and
  // model lets those runs reuse that prefix; websocket and continuation state stay
  // keyed by session id.
  const agentId = params.agentId?.trim();
  if (params.api === "openai-chatgpt-responses" && agentId) {
    const material = JSON.stringify({ version: 1, agentId, model: params.modelId ?? "" });
    return `openclaw-agent-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
  }
  // Reserve the lifecycle suffix inside OpenAI's 64-code-point limit for proxy runtimes.
  const suffix = `:${params.boundaryCount}`;
  const maxSessionIdLength = OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - suffix.length;
  return `${truncateCodePoints(params.sessionId, maxSessionIdLength)}${suffix}`;
}
