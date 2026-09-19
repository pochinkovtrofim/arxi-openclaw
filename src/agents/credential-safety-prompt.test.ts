import { describe, expect, it } from "vitest";
import { buildCredentialSafetyPrompt } from "./credential-safety-prompt.js";

describe("buildCredentialSafetyPrompt", () => {
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
