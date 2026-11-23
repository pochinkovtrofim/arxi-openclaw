import { describe, expect, it } from "vitest";
import { describeAgentRunErrorIdentity } from "../../../../src/agents/agent-run-error-identity.js";
import { CODEX_USAGE_LIMIT_STATE_MISMATCH_MESSAGE } from "./rate-limits.js";
import { CodexUsageLimitPromptError, resolveCodexPromptError } from "./usage-limit-error.js";

const resetsAt = Math.ceil(Date.now() / 1000) + 3600;
const exhausted = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
    rateLimitReachedType: "rate_limit_reached",
  },
};

describe("CodexUsageLimitPromptError identity", () => {
  it("names the subscription limit and carries the reset time", () => {
    const error = resolveCodexPromptError({
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      rateLimits: exhausted,
    });
    expect(error).toBeInstanceOf(CodexUsageLimitPromptError);
    expect(error).toMatchObject({
      name: "CodexUsageLimitPromptError",
      code: "subscription_limit",
      status: 429,
      resetAtMs: resetsAt * 1000,
    });
  });

  it("stays a named limit when the reset is unknown", () => {
    const error = resolveCodexPromptError({
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
    }) as CodexUsageLimitPromptError;
    expect(error.code).toBe("subscription_limit");
    expect(error.resetAtMs).toBeUndefined();
  });

  it("does not call a state mismatch a subscription limit", () => {
    const error = new CodexUsageLimitPromptError(
      `${CODEX_USAGE_LIMIT_STATE_MISMATCH_MESSAGE} Retry the request.`,
    );
    expect(error.code).toBeUndefined();
  });

  it("reaches the run error identity through a wrapper, as a bounded number", () => {
    const cause = new CodexUsageLimitPromptError("limit", resetsAt * 1000);
    const wrapped = new Error("wrapped", { cause });
    expect(describeAgentRunErrorIdentity({ error: wrapped })).toMatchObject({
      causeName: "CodexUsageLimitPromptError",
      causeCode: "subscription_limit",
      resetAtMs: resetsAt * 1000,
    });
  });
});
