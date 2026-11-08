/** Verifies hook decision type guards and normalization helpers. */
import { describe, expect, it } from "vitest";
import { isHookDecision, resolveHoldReason } from "./hook-decision-types.js";

describe("HookDecision helpers", () => {
  describe("isHookDecision", () => {
    it("recognizes supported outcomes", () => {
      expect(isHookDecision({ outcome: "pass" })).toBe(true);
      expect(isHookDecision({ outcome: "block", reason: "policy" })).toBe(true);
      expect(isHookDecision({ outcome: "block", reason: "policy", hold: true })).toBe(true);
    });

    it("rejects non-decision values", () => {
      expect(isHookDecision(null)).toBe(false);
      expect(isHookDecision(undefined)).toBe(false);
      expect(isHookDecision("pass")).toBe(false);
      expect(isHookDecision({ block: true })).toBe(false);
      expect(isHookDecision({ outcome: "ask", reason: "check" })).toBe(false);
      expect(isHookDecision({ outcome: "invalid" })).toBe(false);
      expect(isHookDecision({ outcome: "pass", message: "typo" })).toBe(false);
      expect(isHookDecision({ outcome: "pass", reason: "typo" })).toBe(false);
      expect(isHookDecision({ outcome: "block" })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "" })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", message: "" })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", message: 3 })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", ask: true })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", metadata: [] })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", hold: false })).toBe(false);
      expect(isHookDecision({ outcome: "pass", hold: true })).toBe(false);
    });
  });

  describe("resolveHoldReason", () => {
    it("names the plugin's message and who held the run, and nothing for a refusal", () => {
      const hold = { outcome: "block" as const, reason: "internal", hold: true as const };
      expect(resolveHoldReason({ ...hold, message: " waiting " }, { blockedBy: "policy" })).toBe(
        "waiting (held by policy)",
      );
      expect(resolveHoldReason(hold, { blockedBy: "policy" })).toBe("held by policy");
      expect(resolveHoldReason({ outcome: "block", reason: "internal", message: "no" })).toBe(
        undefined,
      );
    });
  });
});
