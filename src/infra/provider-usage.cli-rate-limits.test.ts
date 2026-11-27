import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCliRateLimitRejection,
  readCliRateLimitSnapshot,
  recordCliRateLimitInfo,
  resetCliRateLimitsForTest,
  settleCliPlanForTest,
} from "./provider-usage.cli-rate-limits.js";

const now = 1_787_000_000_000;
const resetSeconds = Math.floor(now / 1000) + 3600;

describe("provider-usage.cli-rate-limits", () => {
  // No test asks a real program for its plan.
  beforeEach(() => resetCliRateLimitsForTest());
  afterEach(() => resetCliRateLimitsForTest());

  it("names the plan the program reports for its sign-in, asking it at most every six hours", async () => {
    let asked = 0;
    let answer: string | undefined = "Max";
    resetCliRateLimitsForTest(async () => {
      asked++;
      return answer;
    });
    const week = {
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.5,
      resetsAt: resetSeconds,
    };
    expect(readCliRateLimitSnapshot("anthropic", now)).toBeUndefined();
    recordCliRateLimitInfo("anthropic", week);
    await settleCliPlanForTest();
    expect(readCliRateLimitSnapshot("anthropic", now)).toEqual({
      provider: "anthropic",
      displayName: "Claude",
      windows: [{ label: "Week", usedPercent: 50, resetAt: resetSeconds * 1000 }],
      plan: "Max",
    });
    answer = "Pro";
    recordCliRateLimitInfo("anthropic", week);
    await settleCliPlanForTest();
    expect(asked).toBe(1);
    expect(readCliRateLimitSnapshot("anthropic", now)?.plan).toBe("Max");
    // Another provider's report never asks.
    recordCliRateLimitInfo("openai", week);
    expect(asked).toBe(1);
  });

  it("leaves the plan unset while the program names none", async () => {
    resetCliRateLimitsForTest(async () => undefined);
    recordCliRateLimitInfo("anthropic", {
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.2,
      resetsAt: resetSeconds,
    });
    await settleCliPlanForTest();
    expect(readCliRateLimitSnapshot("anthropic", now)).not.toHaveProperty("plan");
  });

  it("reports each window the program named, as the usage endpoint labels them", () => {
    recordCliRateLimitInfo("anthropic", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.42,
      resetsAt: resetSeconds,
    });
    recordCliRateLimitInfo("anthropic", {
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.91,
      surpassedThreshold: 0.9,
      resetsAt: resetSeconds + 86_400,
    });
    expect(readCliRateLimitSnapshot("anthropic", now)).toEqual({
      provider: "anthropic",
      displayName: "Claude",
      windows: [
        { label: "5h", usedPercent: 42, resetAt: resetSeconds * 1000 },
        { label: "Week", usedPercent: 91, resetAt: (resetSeconds + 86_400) * 1000 },
      ],
    });
    expect(readCliRateLimitRejection("anthropic", now)).toBeUndefined();
  });

  it("keeps a window without a share out of the snapshot until it is known", () => {
    recordCliRateLimitInfo("anthropic", {
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: resetSeconds,
    });
    expect(readCliRateLimitSnapshot("anthropic", now)).toBeUndefined();
    recordCliRateLimitInfo("anthropic", {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      surpassedThreshold: 0.75,
      resetsAt: resetSeconds,
    });
    recordCliRateLimitInfo("anthropic", {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      resetsAt: resetSeconds,
    });
    expect(readCliRateLimitSnapshot("anthropic", now)?.windows).toEqual([
      { label: "5h", usedPercent: 75, resetAt: resetSeconds * 1000 },
    ]);
  });

  it("names a used-up window and its reset, and forgets it after the reset", () => {
    recordCliRateLimitInfo("anthropic", {
      status: "rejected",
      rateLimitType: "seven_day",
      resetsAt: resetSeconds,
    });
    expect(readCliRateLimitSnapshot("anthropic", now)?.windows).toEqual([
      { label: "Week", usedPercent: 100, resetAt: resetSeconds * 1000 },
    ]);
    expect(readCliRateLimitRejection("anthropic", now)).toEqual({ resetAtMs: resetSeconds * 1000 });
    expect(readCliRateLimitRejection("anthropic", resetSeconds * 1000)).toBeUndefined();
    expect(readCliRateLimitSnapshot("anthropic", resetSeconds * 1000)).toBeUndefined();
  });

  it("does not take a limit covered by paid extra usage, or an overage window, as used up", () => {
    recordCliRateLimitInfo("anthropic", {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: resetSeconds,
      isUsingOverage: true,
    });
    recordCliRateLimitInfo("anthropic", {
      status: "rejected",
      rateLimitType: "overage",
      resetsAt: resetSeconds,
    });
    expect(readCliRateLimitRejection("anthropic", now)).toBeUndefined();
    expect(readCliRateLimitSnapshot("anthropic", now)?.windows.map((w) => w.label)).toEqual(["5h"]);
  });

  it("does not take a model's own used-up week for the whole plan's", () => {
    recordCliRateLimitInfo("anthropic", {
      status: "rejected",
      rateLimitType: "seven_day_sonnet",
      resetsAt: resetSeconds,
    });
    expect(readCliRateLimitSnapshot("anthropic", now)?.windows).toEqual([
      { label: "Sonnet", usedPercent: 100, resetAt: resetSeconds * 1000 },
    ]);
    expect(readCliRateLimitRejection("anthropic", now)).toBeUndefined();
  });

  it("lifts a used-up window once the program reports it admits calls again", () => {
    recordCliRateLimitInfo("anthropic", {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: resetSeconds,
    });
    recordCliRateLimitInfo("anthropic", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.01,
      resetsAt: resetSeconds + 18_000,
    });
    expect(readCliRateLimitRejection("anthropic", now)).toBeUndefined();
  });

  it("ignores malformed reports", () => {
    for (const info of [
      undefined,
      "rejected",
      { status: "rejected" },
      { status: "maybe", rateLimitType: "five_hour" },
      { status: "allowed", rateLimitType: "five_hour", utilization: Number.NaN },
    ]) {
      recordCliRateLimitInfo("anthropic", info);
    }
    expect(readCliRateLimitSnapshot("anthropic", now)).toBeUndefined();
    expect(readCliRateLimitRejection("anthropic", now)).toBeUndefined();
  });
});
