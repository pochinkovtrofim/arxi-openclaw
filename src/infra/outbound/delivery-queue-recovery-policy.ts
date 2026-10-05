import { isDeliveryRecoveryRetryEligible } from "../delivery-recovery.shared.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

const DEFAULT_MAX_RETRIES = 5;

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /ambiguous .* recipient/i,
  /User .* not in room/i,
];

export function resolveDeliveryRecoveryMaxRetries(entry: QueuedDelivery): number {
  const configured = entry.maxRetries;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_RETRIES;
}

export function resolveDeliveryRecoveryAttemptCount(entry: QueuedDelivery): number {
  const persisted = entry.attemptCount;
  const attemptCount =
    typeof persisted === "number" && Number.isInteger(persisted) && persisted >= 0 ? persisted : 0;
  return Math.max(attemptCount, entry.retryCount);
}

export function isQueuedDeliveryRetryReady(
  entry: QueuedDelivery,
  bypassBackoff: boolean,
  label: string,
  onDeferred: (() => void) | undefined,
  logger: { info(message: string): void },
  now = Date.now(),
): boolean {
  const deferredUntilMs = entry.deferredUntilMs;
  if (
    typeof deferredUntilMs === "number" &&
    Number.isSafeInteger(deferredUntilMs) &&
    deferredUntilMs > now
  ) {
    onDeferred?.();
    const remainingMs = deferredUntilMs - now;
    logger.info(`${label} not ready for retry yet — deferral ${remainingMs}ms remaining`);
    return false;
  }
  const eligibility = isDeliveryRecoveryRetryEligible(entry, now);
  if (!bypassBackoff && !eligibility.eligible) {
    onDeferred?.();
    logger.info(
      `${label} not ready for retry yet — backoff ${eligibility.remainingBackoffMs}ms remaining`,
    );
    return false;
  }
  return true;
}

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
