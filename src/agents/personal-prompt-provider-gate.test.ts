import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyProviderPersonalContext } from "./personal-prompt-provider-gate.js";

const legacyText = "## /workspace/USER.md\n\nKeep owner instructions intact.";
const packetText = 'Personal context: {"status":"ready","source":"business"}';
const segment = {
  name: "USER.md" as const,
  path: "/workspace/USER.md",
  text: legacyText,
  sha256: createHash("sha256").update(legacyText).digest("hex"),
  mandatory: true as const,
};

function request(userText = packetText) {
  return {
    model: "gpt-6-sol",
    instructions: `General rules\n${legacyText}\nOther system rules`,
    input: [{ role: "user", content: [{ type: "input_text", text: `Ask\n${userText}` }] }],
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    stream: true,
  };
}

describe("provider-bound personal prompt gate", () => {
  it("counts the exact combined marginal contribution in the selected provider payload", async () => {
    const countResponseInputTokens = vi.fn(async (body: Record<string, unknown>) =>
      JSON.stringify(body).includes("Personal context:") ? 410 : 270,
    );
    const receipt = await verifyProviderPersonalContext({
      request: request(),
      selectedModelId: "gpt-6-sol",
      segments: [segment],
      packet: { text: packetText, budgetTokens: 8_000 },
      countResponseInputTokens,
    });
    expect(receipt).toMatchObject({
      model: "gpt-6-sol",
      fullTokens: 410,
      baselineTokens: 270,
      personalTokens: 140,
      budgetTokens: 8_000,
      status: "within_budget",
    });
    expect(receipt.requestSha256).toBe(
      createHash("sha256").update(JSON.stringify(request())).digest("hex"),
    );
    expect(countResponseInputTokens).toHaveBeenCalledTimes(2);
    const full = countResponseInputTokens.mock.calls[0]?.[0];
    const baseline = countResponseInputTokens.mock.calls[1]?.[0];
    expect(full?.tools).toEqual(baseline?.tools);
    expect(full?.stream).toBeUndefined();
    expect(JSON.stringify(baseline)).not.toContain(packetText);
    expect(JSON.stringify(baseline)).not.toContain(legacyText);
  });

  it("fails closed with explicit needs_expansion for oversized mandatory context", async () => {
    const countResponseInputTokens = vi.fn(async (body: Record<string, unknown>) =>
      JSON.stringify(body).includes("Personal context:") ? 9_401 : 100,
    );
    await expect(
      verifyProviderPersonalContext({
        request: request(),
        selectedModelId: "gpt-6-sol",
        segments: [segment],
        packet: { text: packetText, budgetTokens: 8_000 },
        countResponseInputTokens,
      }),
    ).rejects.toThrow("needs_expansion");
  });

  it("rejects duplicated or lost packet after later prompt transforms", async () => {
    const countResponseInputTokens = vi.fn(async () => 1);
    for (const userText of [`${packetText}\n${packetText}`, "Packet was removed"]) {
      await expect(
        verifyProviderPersonalContext({
          request: request(userText),
          selectedModelId: "gpt-6-sol",
          segments: [segment],
          packet: { text: packetText, budgetTokens: 8_000 },
          countResponseInputTokens,
        }),
      ).rejects.toThrow("packet missing or duplicated");
    }
    expect(countResponseInputTokens).not.toHaveBeenCalled();
  });

  it("does not substitute a heuristic for a missing selected-model counter", async () => {
    await expect(
      verifyProviderPersonalContext({
        request: request(),
        selectedModelId: "gpt-6-sol",
        segments: [segment],
        packet: { text: packetText, budgetTokens: 8_000 },
      }),
    ).rejects.toThrow("tokenizer unavailable");
  });
});
