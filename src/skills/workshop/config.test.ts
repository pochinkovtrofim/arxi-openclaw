import { describe, expect, it } from "vitest";
import { resolveSkillWorkshopConfig } from "./config.js";

describe("resolveSkillWorkshopConfig", () => {
  it("defaults autonomous learning to auto with channel notices off", () => {
    expect(resolveSkillWorkshopConfig().autonomous).toEqual({
      mode: "auto",
      models: new Map(),
      channelNotices: false,
    });
  });

  it.each([false, true])("reads channel notices %s", (channelNotices) => {
    expect(
      resolveSkillWorkshopConfig({ skills: { workshop: { autonomous: { channelNotices } } } })
        .autonomous.channelNotices,
    ).toBe(channelNotices);
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
