// User copy for Codex app-server, CLI backend timeout and auth-profile failover failures.
import { renderUserMessage, resolveUserMessage } from "../../shared/user-message.js";
import type { CliTimeoutContext } from "./error.js";
import type { FailoverReason } from "./signal.js";

const CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE =
  /\bcodex app-server client closed before turn completed\b/iu;
const CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE =
  /\bcodex app-server turn idle timed out waiting for turn\/completed\b/iu;
const CODEX_SESSION_GENERATION_NOT_CURRENT_RE =
  /\bcodex session generation is no longer current\b/iu;
const CODEX_EXECUTION_NODE_DISCONNECTED_RE =
  /^Codex execution node disconnected; start a fresh attempt\. \((?:execution node (?:failed|disconnected)|execution socket (?:closed|failed))(?:: [^\r\n]{1,240})?\)(?:\r?\n|$)/u;

export function renderCodexAppServerFailureCopy(message: string): string | null {
  const normalizedMessage = message.trim();
  if (CODEX_SESSION_GENERATION_NOT_CURRENT_RE.test(normalizedMessage)) {
    return renderUserMessage(
      { code: "session_changed" },
      "⚠️ This Codex session changed before your message could run. Please send it again.",
    );
  }
  if (CODEX_EXECUTION_NODE_DISCONNECTED_RE.test(normalizedMessage)) {
    return "⚠️ Codex execution node disconnected. Start a fresh attempt.";
  }
  if (CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE.test(normalizedMessage)) {
    return renderUserMessage(
      { code: "connection_retry_exhausted" },
      "⚠️ Lost the connection to Codex before it confirmed the task was finished. It may still be running. Check the conversation in the Control UI before trying again.",
    );
  }
  if (CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE.test(normalizedMessage)) {
    return renderUserMessage(
      { code: "completion_unconfirmed" },
      "⚠️ Codex hasn't confirmed whether the task finished. It may still be running. Check the conversation in the Control UI before trying again.",
    );
  }
  return null;
}

const CLI_BACKEND_NO_OUTPUT_STALL_RE =
  /\bCLI produced no output for\s+(\d+)\s*s\s+and was terminated\b/iu;
const CLI_BACKEND_OVERALL_TIMEOUT_RE =
  /\bCLI exceeded timeout\s*\(\s*(\d+)\s*s\s*\)\s+and was terminated\b/iu;

export function renderCliTimeoutReplyCopy(params: {
  message: string;
  cliTimeout?: CliTimeoutContext;
  provider?: string;
  replayPrevented?: boolean;
}): string | null {
  const stall = params.message.match(CLI_BACKEND_NO_OUTPUT_STALL_RE);
  const overall = params.message.match(CLI_BACKEND_OVERALL_TIMEOUT_RE);
  const timeout = params.cliTimeout;
  const seconds = timeout?.timeoutSeconds ?? Number((stall ?? overall)?.[1]);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  const mode = timeout?.mode ?? (stall ? "no-output" : "overall");
  const mayHaveCompletedWork =
    timeout?.observedActivity ||
    timeout?.backgroundTaskCount ||
    timeout?.activeToolCount ||
    params.replayPrevented;
  const workStatus = mayHaveCompletedWork
    ? " Some work may have completed. Check its results before trying again."
    : "";
  const summary = mode === "no-output" ? "The task stopped responding." : "The task took too long.";
  const remedy =
    mode === "no-output"
      ? "Check for a sign-in or confirmation prompt in the terminal."
      : "Try a smaller task, or increase the task time limit in the Control UI settings.";
  return `⚠️ ${summary}${workStatus} ${remedy}`;
}

type AuthProfileFailureCopyParams = {
  reason: FailoverReason;
  provider: string;
  allInCooldown: boolean;
  recoveryHint?: string;
};

const authProfileUnavailableCopy = (provider: string) =>
  `Couldn't reach ${provider} with any of your saved logins right now.`;

const AUTH_PROFILE_COOLDOWN_COPY = {
  auth: (provider: string) =>
    `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`,
  auth_permanent: (provider: string) => `${provider} isn't accepting your saved login anymore.`,
  format: authProfileUnavailableCopy,
  rate_limit: (provider: string) =>
    `${provider} is asking us to slow down. Please wait a moment before trying again.`,
  overloaded: (provider: string) =>
    `${provider} is overloaded right now. Please wait a moment before trying again.`,
  billing: (provider: string) =>
    `${provider} rejected the request — looks like a billing issue on the account.`,
  server_error: (provider: string) =>
    `${provider} is having issues right now. Please wait a moment before trying again.`,
  timeout: (provider: string) =>
    `${provider} hasn't been responding. Please wait a moment before trying again.`,
  tls_certificate: authProfileUnavailableCopy,
  context_overflow: authProfileUnavailableCopy,
  model_not_found: (provider: string) => `${provider} can't find the model you're using right now.`,
  session_expired: (provider: string) =>
    `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`,
  empty_response: authProfileUnavailableCopy,
  no_error_details: authProfileUnavailableCopy,
  unclassified: authProfileUnavailableCopy,
  unknown: authProfileUnavailableCopy,
} satisfies Record<FailoverReason, (provider: string) => string>;

const AUTH_PROFILE_DIRECT_COPY: Partial<Record<FailoverReason, (provider: string) => string>> = {
  auth: AUTH_PROFILE_COOLDOWN_COPY.auth,
  auth_permanent: (provider) => `${provider} isn't accepting your saved login.`,
  billing: AUTH_PROFILE_COOLDOWN_COPY.billing,
  session_expired: AUTH_PROFILE_COOLDOWN_COPY.session_expired,
};

const AUTH_PROFILE_RECOVERY_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "billing",
  "context_overflow",
  "session_expired",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
]);

export function renderAuthProfileFailoverCopy(params: AuthProfileFailureCopyParams): string {
  const copy = resolveUserMessage({ code: "auth_profile_failure", reason: params.reason });
  if (copy !== undefined) {
    return copy;
  }
  const description = params.allInCooldown
    ? AUTH_PROFILE_COOLDOWN_COPY[params.reason](params.provider)
    : AUTH_PROFILE_DIRECT_COPY[params.reason]?.(params.provider);
  const hint = AUTH_PROFILE_RECOVERY_REASONS.has(params.reason) ? params.recoveryHint : null;
  return [description ?? authProfileUnavailableCopy(params.provider), hint]
    .filter(Boolean)
    .join(" ");
}
