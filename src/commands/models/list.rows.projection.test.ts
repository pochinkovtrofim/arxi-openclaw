import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { Model } from "../../llm/types.js";
import {
  appendDiscoveredRows,
  appendPreparedModelCatalogRows,
  type RowBuilderContext,
} from "./list.rows.js";
import type { ModelRow } from "./list.types.js";

const mocks = vi.hoisted(() => ({
  normalizeProviderResolvedModelWithPlugin: vi.fn((..._args: unknown[]): unknown => undefined),
  resolveBundledProviderPolicySurface: vi.fn((..._args: unknown[]): unknown => null),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  normalizeProviderResolvedModelWithPlugin: mocks.normalizeProviderResolvedModelWithPlugin,
}));

vi.mock("../../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface: mocks.resolveBundledProviderPolicySurface,
}));

describe("appendDiscoveredRows projection", () => {
  it("does not repeat configured metadata lookup after filtering", async () => {
    const providerCatalogScan = vi.fn();
    const providers = new Proxy<Record<string, ModelProviderConfig>>(
      {
        bench: {
          api: "openai-completions",
          baseUrl: "https://models.example.test/v1",
          models: [
            {
              id: "model-1",
              name: "Configured Model",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 64_000,
              maxTokens: 4096,
            },
          ],
        },
      },
      {
        ownKeys(target) {
          providerCatalogScan();
          return Reflect.ownKeys(target);
        },
      },
    );
    const rows: ModelRow[] = [];
    const models: Model[] = [
      {
        id: "model-1",
        name: "Catalog Model",
        api: "openai-completions",
        provider: "bench",
        baseUrl: "https://models.example.test/v1",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ];
    const context: RowBuilderContext = {
      cfg: { models: { providers } },
      agentDir: "/tmp/openclaw-agent",
      authIndex: {
        evaluateModelAuth: () => ({ availability: true, routeResolution: null }),
      },
      canonicalizeProvider: normalizeProviderId,
      configuredByKey: new Map(),
      discoveredKeys: new Set(["bench/model-1"]),
      filter: {},
    };

    await appendDiscoveredRows({
      rows,
      models,
      context,
    });

    expect(providerCatalogScan.mock.calls.length).toBeLessThanOrEqual(1);
    expect(rows).toEqual([
      expect.objectContaining({
        key: "bench/model-1",
        name: "Configured Model",
        input: "text+image",
        contextWindow: 64_000,
        available: true,
      }),
    ]);
  });

  it("normalizes the exact selected physical route before reporting its capabilities", async () => {
    const platform = {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      input: ["text", "image"] as ("text" | "image")[],
      contextWindow: 1_050_000,
    };
    const chatgpt = {
      ...platform,
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"] as ("text" | "image")[],
      contextWindow: 372_000,
    };
    const selectedRoute = {
      api: chatgpt.api,
      baseUrl: chatgpt.baseUrl,
      authRequirement: "subscription" as const,
      requestTransportOverrides: "none" as const,
    };
    mocks.resolveBundledProviderPolicySurface.mockReturnValue({
      projectConfiguredModelRow: vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(undefined),
    });
    mocks.normalizeProviderResolvedModelWithPlugin.mockReturnValue({
      ...chatgpt,
      input: ["text", "image"],
    });
    const rows: ModelRow[] = [];

    await appendPreparedModelCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogSnapshot: {
        entries: [platform],
        routeVariants: [platform, chatgpt],
      },
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => ({
            availability: true,
            routeResolution: {
              kind: "routes" as const,
              routes: [selectedRoute] as [typeof selectedRoute],
            },
            selectedRoute,
          }),
        },
        canonicalizeProvider: normalizeProviderId,
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "openai" },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        key: "openai/gpt-5.6-sol",
        input: "text+image",
        contextWindow: 372_000,
      }),
    ]);
    expect(mocks.normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          model: expect.objectContaining({
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            input: ["text"],
          }),
        }),
      }),
    );
  });
});
