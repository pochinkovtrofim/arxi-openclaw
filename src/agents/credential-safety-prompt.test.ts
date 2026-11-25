import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCredentialSafetyPrompt } from "./credential-safety-prompt.js";

describe("buildCredentialSafetyPrompt", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lets Ro's owner send keys in their chat and still keeps them out of visible text", () => {
    vi.stubEnv("ARXI_CHANNEL_TARGET", "owner");
    for (const input of [{ controlToolsAvailable: false }, { controlToolsAvailable: true }, undefined]) {
      const prompt = buildCredentialSafetyPrompt(input);
      expect(prompt).toContain("ordinary input");
      expect(prompt).toContain("Never echo it");
      expect(prompt).toContain("Never place or suggest credentials/secrets in commands");
      expect(prompt).not.toMatch(/Never request|never ask users|masked credential entry|Never collect/);
    }
  });

  it("keeps the strict lines for Ro's group runtime", () => {
    vi.stubEnv("ARXI_CHANNEL_TARGET", "group");
    expect(buildCredentialSafetyPrompt({ controlToolsAvailable: true })).toContain(
      "Never request or echo credentials/secrets",
    );
  });

  it.each([
    { name: "unavailable controls", input: { controlToolsAvailable: false }, terminalSetup: true },
    { name: "available controls", input: { controlToolsAvailable: true }, terminalSetup: false },
    { name: "legacy tool name", input: "legacy-secrets-tool", terminalSetup: false },
    { name: "omitted availability", input: undefined, terminalSetup: false },
    { name: "unknown availability", input: {}, terminalSetup: false },
  ])("preserves transcript safety and routes setup with $name", ({ input, terminalSetup }) => {
    const prompt = buildCredentialSafetyPrompt(input);
    const lines = prompt.split("\n");

    expect(lines).toHaveLength(terminalSetup ? 4 : 3);
    expect(lines[0]).toContain("Never request or echo credentials/secrets");
    expect(lines[1]).toContain("Never place or suggest credentials/secrets in commands");
    expect(lines[2]).toContain("host-owned masked credential entry");
    expect(prompt.includes("openclaw channels add <channel>")).toBe(terminalSetup);
    expect(prompt.includes("openclaw configure")).toBe(terminalSetup);
    expect(prompt).not.toContain("legacy-secrets-tool");
  });
});
