import { describe, expect, it } from "vitest";
import { resolveSkillWorkshopConfig } from "./config.js";

describe("resolveSkillWorkshopConfig", () => {
  it("defaults autonomous learning to auto", () => {
    expect(resolveSkillWorkshopConfig().autonomous.mode).toBe("auto");
  });

  it.each(["off", "auto"] as const)("reads autonomous mode %s", (mode) => {
    expect(
      resolveSkillWorkshopConfig({ skills: { workshop: { autonomous: { mode } } } }).autonomous
        .mode,
    ).toBe(mode);
  });

  it("keeps review model mappings within one provider", () => {
    const { models } = resolveSkillWorkshopConfig({
      skills: {
        workshop: {
          autonomous: {
            models: {
              " anthropic/claude-opus-5-5 ": "anthropic/claude-sonnet-5-5",
              "anthropic/claude-haiku-5-5": "openai/gpt-review",
              "claude-opus-5-5": "anthropic/claude-sonnet-5-5",
            },
          },
        },
      },
    }).autonomous;
    expect([...models]).toEqual([
      ["anthropic/claude-opus-5-5", { provider: "anthropic", model: "claude-sonnet-5-5" }],
    ]);
  });

  it("does not read the retired boolean key at runtime", () => {
    expect(
      resolveSkillWorkshopConfig({
        skills: { workshop: { autonomous: { enabled: false } } },
      } as never).autonomous.mode,
    ).toBe("auto");
  });
});
