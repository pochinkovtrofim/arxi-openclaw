/** Tests native runtime ownership of catalog thinking capabilities. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile: vi.fn(),
}));

vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
}));

const { isThinkingLevelSupported, listThinkingLevels, resolveProviderThinkingLevel } = await import("./thinking.js");

beforeEach(() => {
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
});

describe("native catalog thinking ownership", () => {
  it("honors an explicit reasoning opt-out over native capabilities", () => {
    const nativeModel = {
      provider: "openai",
      id: "native-model",
      nativeRuntime: "codex",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "high"] },
    };
    const catalog = [nativeModel];
    expect(
      isThinkingLevelSupported({
        provider: "openai",
        model: "native-model",
        catalog,
        agentRuntime: "codex",
        configuredReasoning: false,
        level: "high",
      }),
    ).toBe(false);
    expect(
      listThinkingLevels(
        "openai",
        "native-model",
        [{ ...nativeModel, compat: { supportedReasoningEfforts: [] } }],
        "codex",
      ),
    ).toEqual(["off"]);
  });
  it.each([[], ["low", "high"]])("preserves a native reasoning opt-out: %j", (...efforts) => {
    const catalog = [
      {
        provider: "openai",
        id: "native-model",
        nativeRuntime: "codex",
        reasoning: false,
        compat: { supportedReasoningEfforts: efforts },
      },
    ];
    expect(listThinkingLevels("openai", "native-model", catalog, "codex")).toEqual(["off"]);
  });
  it.each([["low", "medium", "high", "xhigh", "max", "ultra"], ["medium"], ["none", "high"]])(
    "uses observed native efforts plus the upstream Ultra harness mode: %j",
    (...efforts) => {
      providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
        levels: [{ id: "off" }, { id: "minimal" }, { id: "high" }],
      });
      const catalog = [
        {
          provider: "openai",
          id: "native-model",
          nativeRuntime: "codex",
          reasoning: true,
          compat: { supportedReasoningEfforts: efforts },
        },
      ];
      expect(listThinkingLevels("openai", "native-model", catalog, "codex")).toEqual(
        [...new Set([...efforts.map((level) => (level === "none" ? "off" : level)), "ultra"])],
      );
      expect(listThinkingLevels("openai", "native-model", catalog, "openclaw")).toEqual([
        "off",
        "minimal",
        "high",
        "ultra",
      ]);
      expect(resolveProviderThinkingLevel({
        provider: "openai",
        model: "native-model",
        catalog,
        agentRuntime: "codex",
        level: "ultra",
      })).toBe(efforts.findLast((level) => level !== "ultra"));
    },
  );
});
