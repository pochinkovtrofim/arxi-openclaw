import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function expectCatalogEntry(entries: unknown, id: string, expected: Record<string, unknown>): void {
  expect(Array.isArray(entries)).toBe(true);
  const entry = (entries as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === id,
  );
  expectFields(entry, expected);
}

describe("buildOpenAIProvider model input capabilities", () => {
  it.each([["text"], undefined])(
    "repairs stale GPT-6.1 Sol Codex catalog input capabilities: %s",
    (input) => {
      const provider = buildOpenAIProvider();
      expect(
        provider.normalizeResolvedModel?.({
          provider: "openai",
          modelId: "gpt-6.1-sol",
          model: {
            provider: "openai",
            id: "gpt-6.1-sol",
            name: "GPT-6.1 Sol",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            input,
          },
        } as never),
      ).toMatchObject({
        id: "gpt-6.1-sol",
        api: "openai-chatgpt-responses",
        input: ["text", "image"],
      });
    },
  );

  it.each([
    { modelId: "gpt-6.1-sol", contextWindow: 8_192 },
    { modelId: "gpt-5.4", contextWindow: 1_050_000 },
    { modelId: "gpt-5.4-pro", contextWindow: 1_050_000 },
    { modelId: "gpt-5.4-mini", contextWindow: 400_000 },
    { modelId: "gpt-5.4-nano", contextWindow: 400_000 },
  ])(
    "restores native image capability to an existing $modelId catalog row",
    ({ modelId, contextWindow }) => {
      const provider = buildOpenAIProvider();
      const existingRoute = {
        provider: "openai",
        id: modelId,
        name: `Stale ${modelId}`,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        contextWindow: 8_192,
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      };

      const entries = provider.augmentModelCatalog?.({
        env: process.env,
        entries: [existingRoute],
      } as never);

      expectCatalogEntry(entries, modelId, {
        provider: "openai",
        id: modelId,
        name: modelId,
        api: existingRoute.api,
        baseUrl: existingRoute.baseUrl,
        reasoning: true,
        input: ["text", "image"],
        contextWindow,
        cost: existingRoute.cost,
      });
    },
  );
});
