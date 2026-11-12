import { resolveAgentMainSessionKey } from "../../../config/sessions/main-session.js";
import { parseSessionDeliveryRoute } from "../../../sessions/session-key-utils.js";
import type { AgentSession } from "../../sessions/index.js";
import {
  resolveCacheKeepWarm,
  resolveCacheRetention,
  resolveRunCacheRetention,
  resolveRunMessageCacheRetention,
} from "../prompt-cache-retention.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * The run's prompt cache retention: background runs outside a conversation may shorten
 * the configured retention, and conversation turns cache earlier messages. Returns the
 * retention every model call of this session now requests.
 */
export function applyRunPromptCacheRetention(params: {
  session: AgentSession;
  attempt: EmbeddedRunAttemptParams;
  extraParams: Parameters<typeof resolveCacheRetention>[0];
  sessionAgentId: string;
  lastCacheTouchAt?: number | null;
}) {
  const { session, attempt } = params;
  const configuredPromptCacheRetention = resolveCacheRetention(
    params.extraParams,
    attempt.provider,
    attempt.model.api,
    attempt.modelId,
  );
  // A scheduled turn can target a chat session directly (`session:<chat key>`).
  const mainSessionKey = resolveAgentMainSessionKey({
    cfg: attempt.config,
    agentId: params.sessionAgentId,
  });
  const conversation =
    attempt.sessionKey === mainSessionKey || parseSessionDeliveryRoute(attempt.sessionKey) !== null;
  const effectivePromptCacheRetention = resolveRunCacheRetention({
    retention: configuredPromptCacheRetention,
    trigger: attempt.trigger,
    modelApi: attempt.model.api,
    conversation,
    detached: attempt.sessionPersistence === "detached",
    lastCacheTouchAt: params.lastCacheTouchAt,
    now: Date.now(),
  });
  if (effectivePromptCacheRetention !== configuredPromptCacheRetention) {
    const baseStreamFn = session.agent.streamFn;
    session.agent.streamFn = (model, context, options) => {
      const requestOptions = { ...options, cacheRetention: effectivePromptCacheRetention };
      return baseStreamFn(model, context, requestOptions);
    };
  }
  const runStartedAtMs = attempt.startedAtMs;
  const messageCacheRetention = resolveRunMessageCacheRetention({
    retention: effectivePromptCacheRetention,
    trigger: attempt.trigger,
    modelApi: attempt.model.api,
    conversation,
    earlierMessagesInContext:
      runStartedAtMs === undefined ||
      session.messages.some(
        (message) =>
          !(typeof message.timestamp === "number" && message.timestamp >= runStartedAtMs),
      ),
  });
  if (messageCacheRetention) {
    const baseStreamFn = session.agent.streamFn;
    session.agent.streamFn = (model, context, options) => {
      const requestOptions = { ...options, messageCacheRetention };
      return baseStreamFn(model, context, requestOptions);
    };
  }
  return effectivePromptCacheRetention;
}

/** Keeps the prompt cache warm between turns when the agent config asks for it. */
export function applyCacheKeepWarm(
  session: AgentSession,
  attempt: EmbeddedRunAttemptParams,
  retention: ReturnType<typeof applyRunPromptCacheRetention>,
): void {
  const cacheKeepWarm = resolveCacheKeepWarm({
    keepWarmFor: attempt.config?.agents?.defaults?.promptCacheKeepWarm,
    trigger: attempt.trigger,
    modelApi: attempt.model.api,
    retention,
    key: attempt.sessionKey ?? attempt.sessionId,
  });
  if (cacheKeepWarm) {
    const baseStreamFn = session.agent.streamFn;
    session.agent.streamFn = (model, context, options) => {
      const requestOptions = { ...options, cacheKeepWarm };
      return baseStreamFn(model, context, requestOptions);
    };
  }
}
