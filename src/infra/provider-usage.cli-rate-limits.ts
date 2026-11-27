import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { clampPercent, providerUsageLabel } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";

// Claude Code reports its plan's limits in its own stream output
// (`rate_limit_event`), one window at a time and only when they change. When
// the program signs in itself, OpenClaw holds no Claude login to ask the usage
// endpoint with, so these reports are the only view of that plan's limits.
// Kept per provider for the gateway's life: the program's login is the
// process HOME's, one per gateway. A report the warm session receives
// between turns is not seen (extensions/anthropic/cli.runtime.ts keeps only
// a turn's messages), so a window can lag until its next change. The CLI runner writes and the gateway's
// usage.status reads, so the store is a process singleton: the two may load
// different copies of this module.

// The program's names for the plan's own windows, labelled as the usage
// endpoint labels them (provider-usage.fetch.claude.ts). Overage windows are
// paid extra usage, not the plan's limit.
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "Week",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
};

// A used-up window of the whole plan refuses every call. A model's own weekly
// window (Opus, Sonnet) refuses only that model, which a subagent's lighter
// tier may use up while the turn's model still has room.
const PLAN_WINDOWS = new Set(["five_hour", "seven_day"]);

type ReportedWindow = {
  label: string;
  // Unknown until the program reports a utilization or a threshold.
  usedPercent?: number;
  resetAt?: number;
  rejected: boolean;
};

const REPORTED_KEY = Symbol.for("openclaw.providerUsage.cliRateLimits");
const reported = () =>
  resolveGlobalSingleton(
    REPORTED_KEY,
    () => new Map<UsageProviderId, Map<string, ReportedWindow>>(),
  );

function readFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// The program reports a share of the window, 0 to 1.
function readShare(value: unknown): number | undefined {
  const share = readFinite(value);
  return share === undefined || share < 0 ? undefined : clampPercent(Math.min(share, 1) * 100);
}

/** Records one `rate_limit_info` the program reported for a provider's plan. */
export function recordCliRateLimitInfo(provider: UsageProviderId, info: unknown): void {
  if (!isRecord(info) || typeof info.rateLimitType !== "string") {
    return;
  }
  const label = WINDOW_LABELS[info.rateLimitType];
  const status = info.status;
  if (!label || (status !== "allowed" && status !== "allowed_warning" && status !== "rejected")) {
    return;
  }
  const resetSeconds = readFinite(info.resetsAt);
  const resetAt = resetSeconds !== undefined && resetSeconds > 0 ? resetSeconds * 1000 : undefined;
  // Paid extra usage keeps calls going past the plan's limit.
  const rejected =
    status === "rejected" &&
    PLAN_WINDOWS.has(info.rateLimitType) &&
    info.isUsingOverage !== true &&
    info.overageInUse !== true;
  const windows = reported().get(provider) ?? new Map<string, ReportedWindow>();
  const previous = windows.get(label);
  const sameWindow =
    previous !== undefined && (resetAt === undefined || previous.resetAt === resetAt);
  const usedPercent =
    status === "rejected"
      ? 100
      : (readShare(info.utilization) ??
        (status === "allowed_warning" ? readShare(info.surpassedThreshold) : undefined) ??
        (sameWindow ? previous.usedPercent : undefined));
  windows.set(label, {
    label,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...((resetAt ?? (sameWindow ? previous.resetAt : undefined)) !== undefined
      ? { resetAt: resetAt ?? previous?.resetAt }
      : {}),
    rejected,
  });
  reported().set(provider, windows);
}

function currentWindows(provider: UsageProviderId, now: number): ReportedWindow[] {
  const windows = reported().get(provider);
  if (!windows) {
    return [];
  }
  for (const [label, window] of windows) {
    // A window past its reset says nothing about the new one.
    if (window.resetAt !== undefined && window.resetAt <= now) {
      windows.delete(label);
    }
  }
  return [...windows.values()];
}

/** The plan's windows the program last reported, or undefined when none is known. */
export function readCliRateLimitSnapshot(
  provider: UsageProviderId,
  now = Date.now(),
): ProviderUsageSnapshot | undefined {
  const windows: UsageWindow[] = [];
  for (const window of currentWindows(provider, now)) {
    if (window.usedPercent === undefined) {
      continue;
    }
    const entry: UsageWindow = { label: window.label, usedPercent: window.usedPercent };
    if (window.resetAt !== undefined) {
      entry.resetAt = window.resetAt;
    }
    windows.push(entry);
  }
  if (windows.length === 0) {
    return undefined;
  }
  return { provider, displayName: providerUsageLabel(provider) ?? provider, windows };
}

/**
 * A window of the plan the program last reported as used up, with the latest
 * reset among them, or undefined while every window still admits calls.
 */
export function readCliRateLimitRejection(
  provider: UsageProviderId,
  now = Date.now(),
): { resetAtMs?: number } | undefined {
  const rejected = currentWindows(provider, now).filter((window) => window.rejected);
  if (rejected.length === 0) {
    return undefined;
  }
  const resets = rejected.map((window) => window.resetAt);
  // A used-up window without a reset leaves the time unknown.
  return resets.every((reset) => reset !== undefined)
    ? { resetAtMs: Math.max(...(resets as number[])) }
    : {};
}

export function resetCliRateLimitsForTest(): void {
  reported().clear();
}
