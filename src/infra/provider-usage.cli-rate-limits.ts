import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
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

// The plan the program signed in with ("Max", "Pro"), asked of the program
// itself with `claude auth status --json`: OpenClaw never reads its login.
// Ro's host yields her own work later on a larger plan. Asked at most every
// six hours, after the program reported a limit, and kept for the gateway's
// life like the windows; unknown until the first answer.
type CliPlan = { label?: string; checkedAt?: number; pending?: Promise<void> };
type CliPlanProbe = () => Promise<string | undefined>;
const PLAN_KEY = Symbol.for("openclaw.providerUsage.cliPlan");
const PLAN_CHECK_MS = 6 * 60 * 60 * 1000;
const PLAN_PROBE_TIMEOUT_MS = 10_000;
const cliPlan = () => resolveGlobalSingleton(PLAN_KEY, (): CliPlan => ({}));
let planProbe: CliPlanProbe = probeClaudePlan;

async function probeClaudePlan(): Promise<string | undefined> {
  const result = await runUtf8CommandWithTimeout(["claude", "auth", "status", "--json"], {
    timeoutMs: PLAN_PROBE_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    maxCombinedOutputBytes: 64 * 1024,
    terminateOnOutputLimit: true,
    killProcessTree: true,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    return undefined;
  }
  const status: unknown = JSON.parse(result.stdout);
  // Only a Claude account sign-in has a plan; an API key has none.
  if (!isRecord(status) || status.loggedIn !== true || status.authMethod !== "claude.ai") {
    return undefined;
  }
  const plan = typeof status.subscriptionType === "string" ? status.subscriptionType.trim() : "";
  return /^[a-z][a-z0-9_]{0,31}$/i.test(plan)
    ? plan.charAt(0).toUpperCase() + plan.slice(1)
    : undefined;
}

function refreshCliPlan(provider: UsageProviderId, now: number): void {
  const plan = cliPlan();
  if (
    provider !== "anthropic" ||
    plan.pending ||
    (plan.checkedAt !== undefined && now - plan.checkedAt < PLAN_CHECK_MS)
  ) {
    return;
  }
  plan.checkedAt = now;
  plan.pending = planProbe()
    .then((label) => {
      plan.label = label;
    })
    .catch(() => {
      // The plan stays as last known; the next check asks again.
    })
    .finally(() => {
      plan.pending = undefined;
    });
}

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
  refreshCliPlan(provider, Date.now());
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
  const plan = provider === "anthropic" ? cliPlan().label : undefined;
  return {
    provider,
    displayName: providerUsageLabel(provider) ?? provider,
    windows,
    ...(plan ? { plan } : {}),
  };
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

// Tests never ask a real program unless they pass a probe of their own.
export function resetCliRateLimitsForTest(probe: CliPlanProbe = async () => undefined): void {
  reported().clear();
  const plan = cliPlan();
  delete plan.label;
  delete plan.checkedAt;
  delete plan.pending;
  planProbe = probe;
}

export async function settleCliPlanForTest(): Promise<void> {
  await cliPlan().pending;
}
