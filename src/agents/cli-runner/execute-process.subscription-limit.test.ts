import { afterEach, describe, expect, it } from "vitest";
import {
  recordCliRateLimitInfo,
  resetCliRateLimitsForTest,
} from "../../infra/provider-usage.cli-rate-limits.js";
import { describeAgentRunErrorIdentity } from "../agent-run-error-identity.js";
import { FailoverError } from "../failover-error.js";
import { claudeSubscriptionLimitError } from "./execute-process.js";

const claude = {
  backend: { command: "claude", output: "jsonl" as const, jsonlDialect: "claude-stream-json" },
  context: { backendResolved: { id: "claude-cli" } },
};
const failure = () =>
  new FailoverError("Claude CLI failed.", {
    reason: "unknown",
    provider: "claude-cli",
    model: "claude-opus-5-5",
    rawError: "You've hit your limit",
  });

describe("claudeSubscriptionLimitError", () => {
  afterEach(() => resetCliRateLimitsForTest());

  it("names a failed Claude run a subscription limit while the program reports the plan used up", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    recordCliRateLimitInfo("anthropic", {
      status: "rejected",
      rateLimitType: "seven_day",
      resetsAt,
    });
    const original = failure();
    const mapped = claudeSubscriptionLimitError(original, claude);
    expect(mapped).toMatchObject({
      code: "subscription_limit",
      resetAtMs: resetsAt * 1000,
      status: 429,
      provider: "claude-cli",
      model: "claude-opus-5-5",
    });
    expect(mapped?.cause).toBe(original);
    expect(describeAgentRunErrorIdentity({ error: mapped })).toMatchObject({
      code: "subscription_limit",
      resetAtMs: resetsAt * 1000,
    });
  });

  it("leaves other failures, other runtimes and admitted plans alone", () => {
    expect(claudeSubscriptionLimitError(failure(), claude)).toBeUndefined();
    recordCliRateLimitInfo("anthropic", {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: Math.floor(Date.now() / 1000) + 600,
    });
    expect(claudeSubscriptionLimitError(new Error("aborted"), claude)).toBeUndefined();
    // A paired node's program runs on that node's own login.
    expect(
      claudeSubscriptionLimitError(failure(), {
        ...claude,
        nodePlacement: {} as NonNullable<
          Parameters<typeof claudeSubscriptionLimitError>[1]["nodePlacement"]
        >,
      }),
    ).toBeUndefined();
    expect(
      claudeSubscriptionLimitError(failure(), {
        backend: { command: "gemini", output: "jsonl" },
        context: { backendResolved: { id: "gemini-cli" } },
      }),
    ).toBeUndefined();
  });
});
