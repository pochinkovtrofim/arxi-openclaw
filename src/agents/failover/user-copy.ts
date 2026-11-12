import { stableStringify } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCommandErrorForUser } from "../../process/command-error.js";
import {
  CONTEXT_OVERFLOW_ERROR_MESSAGE,
  extractErrorHttpStatus,
  extractLeadingHttpStatus,
  formatRawAssistantErrorForUi,
  formatTransportErrorCopy,
  isCloudflareOrHtmlErrorPage,
  isGenericProviderInternalError,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  parseApiErrorInfo,
  parseApiErrorPayload,
} from "../../shared/assistant-error-format.js";
import { renderUserMessage, resolveUserMessage } from "../../shared/user-message.js";
import { formatExecDeniedUserMessage } from "../exec-approval-result.js";
import {
  ERROR_DETAILS_HINT,
  ERROR_PREFIX_RE,
  renderFormatErrorCopy,
} from "./assistant-request-failure-copy.js";
import { classifyFailoverReasonCore } from "./classify-core.js";
import type { FallbackAttemptRecord } from "./error.js";
import {
  isPeriodicUsageLimitErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  splitFailoverAggregateLegs,
} from "./message-patterns.js";
import {
  classifyProviderRequestFacets,
  type ProviderRequestFacet,
} from "./request-error-facets.js";
import type { FailoverClassification, FailoverReason } from "./signal.js";

export {
  renderAuthProfileFailoverCopy,
  renderCliTimeoutReplyCopy,
  renderCodexAppServerFailureCopy,
} from "./user-copy-runtime-failures.js";

type FailoverUserCopyContext = {
  raw?: string;
  provider?: string;
  model?: string;
  authMode?: string;
};

type FailoverBaseCopyRenderer = (context: FailoverUserCopyContext) => string;

const renderRateLimitErrorUserMessage = () =>
  renderUserMessage(
    { code: "rate_limit" },
    "⚠️ The AI service needs a short break. Please try again in a few minutes.",
  );
export const AUTH_INVALID_TOKEN_USER_TEXT =
  "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.";
export function renderInvalidTokenText(): string {
  return renderUserMessage({ code: "auth_invalid_token" }, AUTH_INVALID_TOKEN_USER_TEXT);
}
const renderSelectedAuthProfileUnavailableUserText = () =>
  renderUserMessage(
    { code: "selected_auth_unavailable" },
    "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.",
  );
export const renderFailoverCodeUserCopy = (code: unknown): string | undefined =>
  code === "selected_auth_profile_unavailable"
    ? renderSelectedAuthProfileUnavailableUserText()
    : undefined;
const renderModelCapacityErrorUserMessage = () =>
  renderUserMessage(
    { code: "model_capacity" },
    "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
  );
const renderOverloadedErrorUserMessage = () =>
  renderUserMessage(
    { code: "overloaded" },
    "The AI service is temporarily overloaded. Please try again in a moment.",
  );
const renderRateLimitRetryMessage = () =>
  renderUserMessage(
    { code: "rate_limit_retry" },
    "⚠️ The AI service needs a short break. Please try again in a few minutes.",
  );
const MODEL_CAPACITY_ERROR_RE = /\b(?:selected\s+)?model\s+(?:is\s+)?at capacity\b/i;
const RATE_LIMIT_SPECIFIC_HINT_RE =
  /\bmin(ute)?s?\b|\bhours?\b|\bseconds?\b|\btry again in\b|\bresets?\b|\bplan\b|\bquota\b/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE =
  /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context (?:length|window) exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const PROVIDER_PROMPT_SIZE_LIMIT_RE =
  /\b(?:this\s+)?prompt\s+(?:is\s+)?(?:too long|longer than)\b.{0,120}\b(?:free tier|single request|per[- ]request)\b/i;
const PROVIDER_PROMPT_SIZE_LIMIT_USER_MESSAGE =
  "⚠️ The provider rejected this request because the prompt exceeds its per-request limit. Shorten the prompt and try again, or choose a model with a larger limit.";
const PROVIDER_PROMPT_SIZE_ERROR_PARSE_MAX_LENGTH = 16_384;
const NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH = 16_384;
const NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE = /^codex\s*error(?:\s+\d{3})?[:\s-]+/i;

/** Format billing copy with optional provider/model and credential context. */
export function formatBillingErrorMessage(
  provider?: string,
  model?: string,
  authMode?: string,
): string {
  const copy = resolveUserMessage({ code: "billing" });
  if (copy !== undefined) {
    return copy;
  }
  const providerName = provider?.trim();
  const modelName = model?.trim();
  const providerLabel =
    providerName && modelName ? `${providerName} (${modelName})` : providerName || undefined;
  const isSubscriptionAuth = authMode === "oauth" || authMode === "token";
  if (isSubscriptionAuth) {
    return `⚠️ ${providerLabel ?? "API provider"} returned a billing error — check your account for subscription or usage limits, then try again.`;
  }
  return providerLabel
    ? `⚠️ ${providerLabel} returned a billing error — check your account's balance and usage limits before trying again.`
    : "⚠️ The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.";
}

const renderBillingErrorUserMessage = () => formatBillingErrorMessage();

function extractProviderRateLimitMessage(raw: string): string | undefined {
  const withoutPrefix = raw.replace(ERROR_PREFIX_RE, "").trim();
  const info = parseApiErrorInfo(raw) ?? parseApiErrorInfo(withoutPrefix);
  const candidate =
    info?.message ?? (extractLeadingHttpStatus(withoutPrefix)?.rest || withoutPrefix);
  if (!candidate || !RATE_LIMIT_SPECIFIC_HINT_RE.test(candidate)) {
    return undefined;
  }
  if (isCloudflareOrHtmlErrorPage(withoutPrefix)) {
    return undefined;
  }
  const trimmed = candidate.trim().replace(/\s+\((?:rate_limit|overloaded|unknown)\)$/iu, "");
  if (
    trimmed.length > 300 ||
    trimmed.startsWith("{") ||
    /^(?:<!doctype\s+html\b|<html\b)/i.test(trimmed)
  ) {
    return undefined;
  }
  return `⚠️ ${trimmed}`;
}

const FAILOVER_REASON_BASE_COPY = {
  auth: () => renderInvalidTokenText(),
  auth_permanent: () => renderInvalidTokenText(),
  format: (context) => renderFormatErrorCopy(context.raw ?? ""),
  rate_limit: (context) =>
    renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: context.raw }),
  overloaded: (context) =>
    renderRateLimitOrOverloadedCopy({ reason: "overloaded", raw: context.raw }),
  billing: (context) =>
    formatBillingErrorMessage(context.provider, context.model, context.authMode),
  server_error: () =>
    renderUserMessage(
      { code: "server_error" },
      "LLM request failed: provider returned an internal error.",
    ),
  timeout: () => renderUserMessage({ code: "timeout" }, "LLM request timed out."),
  tls_certificate: () =>
    renderUserMessage(
      { code: "tls_certificate" },
      "LLM request failed: TLS certificate validation rejected the provider endpoint. Check the endpoint hostname, proxy, and local certificate trust.",
    ),
  context_overflow: () =>
    renderUserMessage({ code: "context_overflow" }, CONTEXT_OVERFLOW_ERROR_MESSAGE),
  model_not_found: () =>
    renderUserMessage(
      { code: "model_not_found" },
      "The selected model was not found by the provider. Check the model id or choose a different model.",
    ),
  session_expired: () =>
    renderUserMessage(
      { code: "session_expired" },
      "The provider session expired. Start a new session and try again.",
    ),
  empty_response: () =>
    renderUserMessage(
      { code: "empty_response" },
      "The model returned an empty response. Please try again.",
    ),
  no_error_details: () =>
    renderUserMessage({ code: "unknown_error" }, "LLM request failed with an unknown error."),
  unclassified: () => renderUserMessage({ code: "request_failed" }, "LLM request failed."),
  unknown: () =>
    renderUserMessage({ code: "unknown_error" }, "LLM request failed with an unknown error."),
} satisfies Record<FailoverReason, FailoverBaseCopyRenderer>;
function renderProviderPromptSizeLimitCopy(raw: string): string | undefined {
  if (raw.length > PROVIDER_PROMPT_SIZE_ERROR_PARSE_MAX_LENGTH) {
    return undefined;
  }
  const status = extractErrorHttpStatus(raw);
  if (status?.code !== 400) {
    return undefined;
  }
  const info = parseApiErrorInfo(raw) ?? parseApiErrorInfo(status.rest);
  const providerMessage = info?.message ?? status.rest;
  return providerMessage.length <= 300 && PROVIDER_PROMPT_SIZE_LIMIT_RE.test(providerMessage)
    ? renderUserMessage({ code: "prompt_size_limit" }, PROVIDER_PROMPT_SIZE_LIMIT_USER_MESSAGE)
    : undefined;
}

/** Render only controller-recorded exhaustion, never infer it from provider text. */
export function renderRateLimitRetryExhaustion(
  retries: number | undefined,
  finalModel = false,
): string | undefined {
  if (retries === undefined) {
    return undefined;
  }
  const scope = finalModel ? " on the final model" : "";
  return retries === 0
    ? `Automatic rate-limit recovery is disabled${scope} for this session (retry.provider.maxRetries: 0).`
    : `Rate-limit recovery stopped${scope} after ${retries} automatic ${retries === 1 ? "retry" : "retries"} without a completed model response. Check completed work before trying again.`;
}

/** Render rate-limit versus overload copy from the canonical classified reason. */
export function renderRateLimitOrOverloadedCopy(params: {
  reason: Extract<FailoverReason, "rate_limit" | "overloaded">;
  raw?: string;
  rateLimitRetriesExhausted?: number;
}): string {
  const exhaustion =
    params.reason === "rate_limit"
      ? renderRateLimitRetryExhaustion(params.rateLimitRetriesExhausted)
      : undefined;
  if (exhaustion) {
    return exhaustion;
  }
  const raw = params.raw ?? "";
  if (MODEL_CAPACITY_ERROR_RE.test(raw)) {
    return renderModelCapacityErrorUserMessage();
  }
  if (params.reason === "overloaded") {
    return renderOverloadedErrorUserMessage();
  }
  // Product copy replaces provider-supplied rate-limit wording as well as the default.
  const copy = resolveUserMessage({ code: "rate_limit" });
  if (copy !== undefined) {
    return copy;
  }
  const promptSizeCopy = renderProviderPromptSizeLimitCopy(raw);
  if (promptSizeCopy) {
    return promptSizeCopy;
  }
  for (const leg of splitFailoverAggregateLegs(raw)) {
    const fromLeg = extractProviderRateLimitMessage(leg);
    if (fromLeg) {
      return fromLeg;
    }
  }
  return extractProviderRateLimitMessage(raw) ?? renderRateLimitErrorUserMessage();
}

export function formatDiskSpaceErrorCopy(raw: string): string | undefined {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return /\benospc\b/i.test(raw) ||
    lower.includes("no space left on device") ||
    lower.includes("disk full")
    ? renderUserMessage(
        { code: "disk_full" },
        "OpenClaw could not write local session data because the disk is full. Free some disk space and try again.",
      )
    : undefined;
}

export function isInvalidStreamingEventOrderError(raw: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return (
    lower.includes("unexpected event order") &&
    lower.includes("message_start") &&
    lower.includes("message_stop")
  );
}

export function isStreamingJsonParseError(raw: string): boolean {
  return raw.trim() === MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE;
}

export function getApiErrorPayloadFingerprint(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  const payload = parseApiErrorPayload(raw);
  return payload ? stableStringify(payload) : null;
}

export function isRawApiErrorPayload(raw?: string): boolean {
  return getApiErrorPayloadFingerprint(raw) !== null;
}

/** Recognize provider HTTP/HTML failures from canonical classification facts. */
export function isLikelyHttpErrorText(raw: string): boolean {
  if (isCloudflareOrHtmlErrorPage(raw)) {
    return true;
  }
  const status = extractLeadingHttpStatus(raw);
  return Boolean(
    status &&
    status.code >= 400 &&
    (classifyFailoverReasonCore(raw) !== null ||
      classifyProviderRequestFacets({ status: status.code, message: raw }) !== null),
  );
}

function shouldRewriteRawPayloadWithoutErrorContext(raw: string): boolean {
  if (
    raw.length > NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH ||
    !NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE.test(raw)
  ) {
    return false;
  }
  const info = parseApiErrorInfo(raw);
  const normalizedType = normalizeLowercaseStringOrEmpty(info?.type);
  if (normalizedType.endsWith("_error")) {
    return true;
  }
  const code = Number(info?.httpCode);
  return Number.isFinite(code) && code >= 400;
}

/** Sanitize presentation text, then render error copy from classified facts when requested. */
export function renderSanitizedUserFacingText(
  sanitized: string,
  opts?: { errorContext?: boolean },
): string {
  if (!sanitized) {
    return sanitized;
  }
  const trimmed = sanitized.trim();
  if (!opts?.errorContext) {
    return shouldRewriteRawPayloadWithoutErrorContext(trimmed)
      ? formatRawAssistantErrorForUi(trimmed)
      : sanitized;
  }
  for (const format of [
    formatCommandErrorForUser,
    formatExecDeniedUserMessage,
    formatDiskSpaceErrorCopy,
  ]) {
    const copy = format(trimmed);
    if (copy) {
      return copy;
    }
  }
  if (/incorrect role information|roles must alternate/i.test(trimmed)) {
    return renderUserMessage(
      { code: "message_order" },
      "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.",
    );
  }
  const reason = classifyFailoverReasonCore(trimmed);
  const status = extractLeadingHttpStatus(trimmed);
  const rawPayload = isRawApiErrorPayload(trimmed);
  if (
    reason === "context_overflow" &&
    (rawPayload ||
      (status && status.code >= 400) ||
      ERROR_PREFIX_RE.test(trimmed) ||
      CONTEXT_OVERFLOW_ERROR_HEAD_RE.test(trimmed))
  ) {
    return FAILOVER_REASON_BASE_COPY.context_overflow();
  }
  if (reason === "billing" || reason === "rate_limit" || reason === "overloaded") {
    return reason === "billing"
      ? renderBillingErrorUserMessage()
      : renderRateLimitOrOverloadedCopy({ reason, raw: trimmed });
  }
  // Labeled HTTP statuses require the full grammar; keep provider retry detail above.
  const providerRequestCode = resolveProviderRequestFailureCode({
    classification: reason ? { kind: "reason", reason } : null,
    facet: null,
    status: extractErrorHttpStatus(trimmed)?.code,
  });
  if (providerRequestCode) {
    return PROVIDER_REQUEST_COPY[providerRequestCode]();
  }
  if (isGenericProviderInternalError(trimmed)) {
    return formatRawAssistantErrorForUi(trimmed);
  }
  if (isInvalidStreamingEventOrderError(trimmed)) {
    return renderUserMessage(
      { code: "streaming_invalid" },
      "LLM request failed: provider returned an invalid streaming response. Please try again.",
    );
  }
  if (rawPayload || (status && status.code >= 400 && reason)) {
    return formatRawAssistantErrorForUi(trimmed);
  }
  if (isStreamingJsonParseError(trimmed)) {
    return renderUserMessage(
      { code: "streaming_fragment" },
      "LLM streaming response contained a malformed fragment. Please try again.",
    );
  }
  if (ERROR_PREFIX_RE.test(trimmed)) {
    const transport = formatTransportErrorCopy(trimmed);
    if (transport) {
      return transport;
    }
    if (isProviderCompletedErrorFinishReasonMessage(trimmed)) {
      return formatRawAssistantErrorForUi(trimmed);
    }
    if (reason === "timeout") {
      return FAILOVER_REASON_BASE_COPY.timeout();
    }
    return formatRawAssistantErrorForUi(trimmed);
  }
  return sanitized;
}

const GENERIC_EXTERNAL_RUN_FAILURE_DEFAULT_TEXT =
  "⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.";
export function renderExternalRunFailureText(): string {
  return renderUserMessage(
    { code: "external_run_failure" },
    GENERIC_EXTERNAL_RUN_FAILURE_DEFAULT_TEXT,
  );
}
/** Core default wording; rendered copy goes through `renderExternalRunFailureText`. */
export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT = GENERIC_EXTERNAL_RUN_FAILURE_DEFAULT_TEXT;
// A failed background turn can have partial effects; it does not establish chat health.
const HEARTBEAT_FAILURE_LEAD = "⚠️ The background check did not complete.";
const HEARTBEAT_FAILURE_LOG_HINT = "Troubleshooting: run `openclaw logs --follow` in a terminal.";
export const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT = `${HEARTBEAT_FAILURE_LEAD}\n\n${HEARTBEAT_FAILURE_LOG_HINT}`;
export function renderHeartbeatFailureText(): string {
  return renderUserMessage({ code: "heartbeat_failure" }, HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
}
export const PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE =
  "⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.";
export function renderConversationStateErrorText(): string {
  return renderUserMessage(
    { code: "conversation_state" },
    PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
  );
}
const renderProviderRateLimitOrQuotaErrorUserMessage = () =>
  renderUserMessage(
    { code: "rate_limit_quota" },
    "⚠️ The AI service can't accept more requests right now. Wait a few minutes, then try again. If it continues, check your account's usage and billing limits.",
  );
const renderProviderInternalErrorUserMessage = () =>
  renderUserMessage(
    { code: "provider_internal" },
    "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.",
  );

/** `reason` is the failure-reply owner's already sanitized and capped detail. */
export function renderHeartbeatRunFailureCopy(reason?: string): string {
  const copy = resolveUserMessage({ code: "heartbeat_failure" });
  if (copy !== undefined) {
    return copy;
  }
  if (!reason) {
    return renderHeartbeatFailureText();
  }
  const terminator = /[.!?]$/u.test(reason) ? "" : ".";
  return `${HEARTBEAT_FAILURE_LEAD}\n\nDetails: ${reason}${terminator}\n${HEARTBEAT_FAILURE_LOG_HINT}`;
}

const renderProviderAuthenticationErrorUserMessage = () => `⚠️ ${renderInvalidTokenText()}`;
const renderProviderModelUnavailableUserMessage = () =>
  renderUserMessage(
    { code: "model_unavailable" },
    "⚠️ This model was not found. Choose another model in the Control UI or run `openclaw configure`.",
  );

const PROVIDER_REQUEST_COPY = {
  provider_authentication_error: renderProviderAuthenticationErrorUserMessage,
  provider_conversation_state_error: renderConversationStateErrorText,
  provider_internal_error: renderProviderInternalErrorUserMessage,
  provider_model_unavailable: renderProviderModelUnavailableUserMessage,
  provider_rate_limit_or_quota_error: renderProviderRateLimitOrQuotaErrorUserMessage,
};

type ProviderRequestErrorCode = keyof typeof PROVIDER_REQUEST_COPY;

function resolveProviderRequestFailureCode(params: {
  classification: FailoverClassification | null;
  facet: ProviderRequestFacet | null;
  status?: number;
}): ProviderRequestErrorCode | undefined {
  const reason =
    params.classification?.kind === "reason" ? params.classification.reason : undefined;
  if (reason === "auth" && params.status === 401) {
    return "provider_authentication_error";
  }
  if (reason === "model_not_found") {
    return "provider_model_unavailable";
  }
  switch (params.facet) {
    case "quota-429":
      return "provider_rate_limit_or_quota_error";
    case "conversation-state":
      return "provider_conversation_state_error";
    case "provider-internal":
    case "provider-internal-503":
      return "provider_internal_error";
    default:
      return undefined;
  }
}

export function resolveProviderRequestFailureCopy(params: {
  classification: FailoverClassification | null;
  facet: ProviderRequestFacet | null;
  status?: number;
  technicalMessage: string;
}) {
  const code = resolveProviderRequestFailureCode(params);
  if (!code) {
    return undefined;
  }
  return {
    code,
    userMessage: PROVIDER_REQUEST_COPY[code](),
    technicalMessage: params.technicalMessage,
  };
}

export type ReplyFallbackAttempt = FallbackAttemptRecord & { authMode?: string };

function extractCodexUsageLimitErrorMessage(
  attempts: readonly ReplyFallbackAttempt[],
  directMessage: string,
  directReason: FailoverReason | undefined,
  directProvider: string | undefined,
  sanitizeText?: (text: string) => string,
): string | undefined {
  const attempt = attempts.find(
    (candidate) =>
      candidate.provider === "openai" && candidate.reason === "rate_limit" && candidate.error,
  );
  const text =
    attempt?.error ??
    (directProvider === "openai" && directReason === "rate_limit" ? directMessage : undefined);
  if (!text) {
    return undefined;
  }
  // The attempt already classifies this as a rate limit. A presentation plugin
  // must not depend on recognizing the provider's free-form wording again.
  const message = (
    resolveUserMessage({ code: "rate_limit" }) ??
    renderSanitizedUserFacingText(sanitizeText?.(text) ?? text, {
      errorContext: true,
    })
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!message) {
    return undefined;
  }
  const truncated = message.length > 500 ? `${truncateUtf16Safe(message, 497)}...` : message;
  return truncated.startsWith("⚠️") ? truncated : `⚠️ ${truncated}`;
}

/** Render the reply surface's rate-limit copy, including structured cooldown context. */
export function renderRateLimitReplyCopy(params: {
  message: string;
  reason?: FailoverReason;
  provider?: string;
  attempts?: readonly ReplyFallbackAttempt[];
  rateLimitRetriesExhausted?: number;
  cooldownExpiry?: number | null;
  nowMs?: number;
  sanitizeText?: (text: string) => string;
}): string {
  const attempts = params.attempts ?? [];
  if (params.reason === "rate_limit") {
    const promptSizeCopy = renderProviderPromptSizeLimitCopy(params.message);
    if (promptSizeCopy) {
      return promptSizeCopy;
    }
  }
  const exhaustion =
    params.reason === "rate_limit" && !attempts.some((attempt) => attempt.reason === "billing")
      ? renderRateLimitRetryExhaustion(
          attempts.length
            ? attempts.at(-1)?.rateLimitRetriesExhausted
            : params.rateLimitRetriesExhausted,
          attempts.length > 1,
        )
      : undefined;
  if (exhaustion) {
    return exhaustion;
  }
  const usageLimit = extractCodexUsageLimitErrorMessage(
    attempts,
    params.message,
    params.reason,
    params.provider,
    params.sanitizeText,
  );
  if (usageLimit) {
    return usageLimit;
  }
  if (attempts.some((attempt) => attempt.reason === "billing") || params.reason === "billing") {
    return renderBillingErrorUserMessage();
  }
  if (attempts.length === 0) {
    if (params.reason === "rate_limit" && isPeriodicUsageLimitErrorMessage(params.message)) {
      const providerMessage = renderSanitizedUserFacingText(
        params.sanitizeText?.(params.message) ?? params.message,
        { errorContext: true },
      );
      return providerMessage.startsWith("⚠️") ? providerMessage : `⚠️ ${providerMessage}`;
    }
    return renderRateLimitRetryMessage();
  }
  // Product copy replaces provider-supplied rate-limit wording.
  const providerHintsAllowed = resolveUserMessage({ code: "rate_limit" }) === undefined;
  for (const attempt of attempts) {
    if (!providerHintsAllowed || attempt.reason !== "rate_limit" || !attempt.error) {
      continue;
    }
    const hint = extractProviderRateLimitMessage(attempt.error);
    if (hint) {
      return params.sanitizeText?.(attempt.error) ?? hint;
    }
  }
  const expiry = params.cooldownExpiry;
  const nowMs = params.nowMs ?? Date.now();
  if (typeof expiry === "number" && expiry > nowMs) {
    const secsLeft = Math.max(1, Math.ceil((expiry - nowMs) / 1000));
    return secsLeft <= 60
      ? renderUserMessage(
          { code: "cooldown_seconds", seconds: secsLeft },
          `⚠️ The AI service needs a short break. Please try again in ~${secsLeft}s.`,
        )
      : renderUserMessage(
          { code: "cooldown_minutes", minutes: Math.ceil(secsLeft / 60) },
          `⚠️ The AI service needs a short break. Please try again in ~${Math.ceil(secsLeft / 60)} min.`,
        );
  }
  const attemptedModels = new Set(
    attempts.map((attempt) => `${attempt.provider}/${attempt.model}`),
  );
  return attemptedModels.size > 1 &&
    attempts.every((attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded")
    ? renderUserMessage(
        { code: "all_models_limited" },
        "⚠️ The AI services are busy. Please try again in a few minutes.",
      )
    : renderRateLimitRetryMessage();
}

export function renderBillingReplyCopy(params: {
  provider?: string;
  model?: string;
  authMode?: string;
  attempts?: readonly ReplyFallbackAttempt[];
}): string {
  const attempts = params.attempts ?? [];
  const billingFailure =
    attempts.length > 0
      ? attempts.find(
          (attempt) =>
            attempt.reason === "billing" &&
            (attempt.authMode === "oauth" || attempt.authMode === "token"),
        )
      : params.authMode === "oauth" || params.authMode === "token"
        ? params
        : undefined;
  return billingFailure
    ? formatBillingErrorMessage(
        billingFailure.provider,
        billingFailure.model,
        billingFailure.authMode,
      )
    : renderBillingErrorUserMessage();
}

export function renderMissingApiKeyReplyCopy(params?: {
  provider: string;
  providerGuidance?: boolean;
}): string | null {
  const copy = resolveUserMessage({ code: "missing_credentials" });
  if (copy !== undefined) {
    return copy;
  }
  const provider = params?.provider.trim().toLowerCase();
  if (!provider) {
    return null;
  }
  if (provider === "openai" && params?.providerGuidance) {
    return "⚠️ OpenAI needs a different sign-in for this model. Open Models in the Control UI or run `openclaw configure` to choose how to connect.";
  }
  return provider === "openai"
    ? "⚠️ Couldn't connect to OpenAI. Run `openclaw doctor --fix`, then try again. If it still fails, open Models in the Control UI or run `openclaw configure`."
    : "⚠️ This AI service isn't set up yet. Sign in under Models in the Control UI or run `openclaw configure`.";
}

export function renderControlUiAgentFailureCopy(): string {
  return `⚠️ OpenClaw couldn't finish this reply. Check the conversation before trying again. ${ERROR_DETAILS_HINT}`;
}

export function replaceGenericExternalRunFailureText(text: string): {
  text: string;
  replaced: boolean;
} {
  const start = text.indexOf(renderExternalRunFailureText());
  if (start < 0 || text.slice(start + renderExternalRunFailureText().length).trim()) {
    return { text, replaced: false };
  }
  const prefix = text.slice(0, start).trimEnd();
  return {
    text: prefix ? `${prefix} ${renderHeartbeatFailureText()}` : renderHeartbeatFailureText(),
    replaced: true,
  };
}
