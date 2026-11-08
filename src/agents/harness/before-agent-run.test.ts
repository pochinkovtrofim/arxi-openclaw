/** Verifies the before_agent_run gate's block and hold results. */
import { describe, expect, it } from "vitest";
import {
  AgentRunBlockedError,
  resolveAgentRunHeldReason,
  runBeforeAgentRunGate,
} from "./before-agent-run.js";

const event = { prompt: "check the news", messages: [] };
const gate = (decision: Record<string, unknown>) =>
  runBeforeAgentRunGate(
    {
      hasHooks: () => true,
      runBeforeAgentRun: async () => ({ pluginId: "policy", decision }) as never,
    },
    event as never,
    {} as never,
  );

describe("runBeforeAgentRunGate", () => {
  it("carries a held run's reason next to the refusal text", async () => {
    const block = await gate({ outcome: "block", reason: "internal", message: "Waiting", hold: true });
    expect(block).toEqual({
      blockedBy: "policy",
      message: "Your message could not be sent: Waiting (blocked by policy)",
      heldReason: "Waiting (held by policy)",
    });
    expect(resolveAgentRunHeldReason(new AgentRunBlockedError(block!))).toBe(
      "Waiting (held by policy)",
    );
  });

  it("gives a refusal no held reason", async () => {
    const block = await gate({ outcome: "block", reason: "internal" });
    expect(block).toEqual({
      blockedBy: "policy",
      message: "Your message could not be sent: blocked by policy",
    });
    expect(resolveAgentRunHeldReason(new AgentRunBlockedError(block!))).toBeUndefined();
    expect(resolveAgentRunHeldReason(new Error("other"))).toBeUndefined();
  });
});
