/**
 * Structured decision returned by gate/policy hooks.
 * Core is outcome-agnostic — it handles the mechanics of each outcome
 * without knowing *why* the decision was made.
 */
type HookDecision = HookDecisionPass | HookDecisionBlock;

/** Content is fine. Proceed normally. */
type HookDecisionPass = {
  outcome: "pass";
};

/** Prefix for user-facing replacement messages when a `block` decision stops a request. */
const BLOCK_MESSAGE_PREFIX = "Your message could not be sent";

/**
 * Content is blocked. `reason` is internal plugin-local detail; core must not log,
 * persist, broadcast, or expose it verbatim. `message` is user-facing detail.
 */
type HookDecisionBlock = {
  outcome: "block";
  /** Internal plugin-local reason. Do not log, persist, broadcast, or expose verbatim. */
  reason: string;
  /** Optional user-facing detail included in the block response envelope. */
  message?: string;
  /** Plugin-defined category for analytics (e.g. "violence", "pii", "cost_limit"). */
  category?: string;
  /** Opaque metadata for the plugin's own use. Core does not interpret it. */
  metadata?: Record<string, unknown>;
  /**
   * The run waits for a condition the plugin owns instead of being refused. A
   * scheduled run then settles as skipped with `message` as its recorded reason,
   * not as a failure; any other run is blocked as usual.
   */
  hold?: true;
};

export function resolveBlockMessage(
  decision: HookDecisionBlock,
  params: { blockedBy?: string } = {},
): string {
  const message = typeof decision.message === "string" ? decision.message.trim() : "";
  const blockedBy = params.blockedBy?.trim();
  if (message) {
    return blockedBy
      ? `${BLOCK_MESSAGE_PREFIX}: ${message} (blocked by ${blockedBy})`
      : `${BLOCK_MESSAGE_PREFIX}: ${message}`;
  }
  return blockedBy
    ? `${BLOCK_MESSAGE_PREFIX}: blocked by ${blockedBy}`
    : `${BLOCK_MESSAGE_PREFIX}: blocked`;
}

/** The reason a scheduled run records when a plugin held it; undefined for a refusal. */
export function resolveHoldReason(
  decision: HookDecisionBlock,
  params: { blockedBy?: string } = {},
): string | undefined {
  if (decision.hold !== true) {
    return undefined;
  }
  const message = typeof decision.message === "string" ? decision.message.trim() : "";
  const heldBy = params.blockedBy?.trim();
  if (message) {
    return heldBy ? `${message} (held by ${heldBy})` : message;
  }
  return heldBy ? `held by ${heldBy}` : "held";
}

/**
 * Type guard: does this object look like a HookDecision (has `outcome` field)?
 */
export function isHookDecision(value: unknown): value is HookDecision {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (v.outcome === "pass") {
    return keys.length === 1;
  }
  if (v.outcome !== "block") {
    return false;
  }
  const allowedBlockKeys = new Set([
    "outcome",
    "reason",
    "message",
    "category",
    "metadata",
    "hold",
  ]);
  if (keys.some((key) => !allowedBlockKeys.has(key))) {
    return false;
  }
  if (typeof v.reason !== "string" || !v.reason.trim()) {
    return false;
  }
  if ("message" in v && (typeof v.message !== "string" || !v.message.trim())) {
    return false;
  }
  if ("category" in v && (typeof v.category !== "string" || !v.category.trim())) {
    return false;
  }
  if ("hold" in v && v.hold !== true) {
    return false;
  }
  if (
    "metadata" in v &&
    (typeof v.metadata !== "object" || v.metadata === null || Array.isArray(v.metadata))
  ) {
    return false;
  }
  return true;
}

/** Outcomes valid for input gates (before_agent_run). */
export type InputGateDecision = HookDecisionPass | HookDecisionBlock;

/**
 * A gate hook decision paired with the pluginId that produced it.
 * Returned by gate hook runners so callers can
 * attribute blocked entries and audit events to the originating plugin.
 */
export type GateHookResult<TDecision extends HookDecision = HookDecision> = {
  decision: TDecision;
  pluginId: string;
};
