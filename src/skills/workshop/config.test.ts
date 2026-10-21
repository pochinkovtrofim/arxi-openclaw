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

  it("splits the review model into provider and model id", () => {
    const read = (model: string) =>
      resolveSkillWorkshopConfig({ skills: { workshop: { autonomous: { model } } } }).autonomous
        .model;
    expect(read(" anthropic/claude-sonnet-5-5 ")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(read("claude-sonnet-5-5")).toBeUndefined();
    expect(read("anthropic/")).toBeUndefined();
  });

  it("does not read the retired boolean key at runtime", () => {
    expect(
      resolveSkillWorkshopConfig({
        skills: { workshop: { autonomous: { enabled: false } } },
      } as never).autonomous.mode,
    ).toBe("auto");
  });
});
