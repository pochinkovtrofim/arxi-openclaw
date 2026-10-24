// Cache-TTL delegation, built-in fallback, and session-marker coverage.
import { describe, expect, it, vi } from "vitest";

const providerEligibility = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: (params: { context: { provider: string } }) => {
    providerEligibility(params);
    if (params.context.provider === "moonshot" || params.context.provider === "zai") {
      return true;
    }
    if (params.context.provider === "openrouter") {
      return false;
    }
    return undefined;
  },
}));

import { SessionManager } from "../sessions/session-manager.js";
import {
  isCacheTtlEligibleProvider,
  readLastAssistantCacheTouch,
  readLastCacheTtlTimestamp,
} from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("forwards only the normalized identity and bounded resolved route", () => {
    providerEligibility.mockClear();
    const route = {
      baseUrl: "https://proxy.example/v1",
      supportsPromptCacheKey: false,
      headers: { "x-test-private": "not-for-provider-hooks" },
      apiKey: "synthetic-not-for-provider-hooks",
    };
    isCacheTtlEligibleProvider(" OPENAI ", " GPT-4O ", "openai-responses", route);
    expect(providerEligibility).toHaveBeenCalledExactlyOnceWith({
      provider: "openai",
      context: {
        provider: "openai",
        modelId: "gpt-4o",
        modelApi: "openai-responses",
        baseUrl: "https://proxy.example/v1",
        supportsPromptCacheKey: false,
      },
    });
  });

  it("is case-insensitive for native providers", () => {
    expect(isCacheTtlEligibleProvider("Moonshot", "Kimi-K2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("ZAI", "GLM-5")).toBe(true);
  });

  it("rejects unsupported providers and models", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
    expect(
      isCacheTtlEligibleProvider("openrouter", "model-1", "openai-responses", {
        supportsPromptCacheKey: true,
      }),
    ).toBe(false);
    expect(
      isCacheTtlEligibleProvider("myproxy", "model-1", "custom-api", {
        supportsPromptCacheKey: true,
      }),
    ).toBe(false);
  });

  it.each(["openai-responses", "openai-completions", "openai-chatgpt-responses"])(
    "requires explicit cache support for a custom %s provider",
    (modelApi) => {
      const route = { baseUrl: "https://proxy.example/v1" };
      expect(
        isCacheTtlEligibleProvider("myproxy", "model-1", modelApi, {
          ...route,
          supportsPromptCacheKey: true,
        }),
      ).toBe(true);
      expect(
        isCacheTtlEligibleProvider("myproxy", "model-1", modelApi, {
          ...route,
          supportsPromptCacheKey: false,
        }),
      ).toBe(false);
      expect(isCacheTtlEligibleProvider("myproxy", "model-1", modelApi, route)).toBe(false);
    },
  );

  it("allows direct Google Gemini cache-ttl models", () => {
    expect(
      isCacheTtlEligibleProvider("google", "gemini-3.1-pro-preview", "google-generative-ai"),
    ).toBe(true);
    expect(isCacheTtlEligibleProvider("google", "gemini-2.5-flash", "google-generative-ai")).toBe(
      true,
    );
  });

  it("rejects non-cacheable Google model families", () => {
    expect(
      isCacheTtlEligibleProvider("google", "gemini-live-2.5-flash-preview", "google-generative-ai"),
    ).toBe(false);
  });

  it("allows custom anthropic-messages providers", () => {
    expect(isCacheTtlEligibleProvider("litellm", "claude-sonnet-4-6", "anthropic-messages")).toBe(
      true,
    );
  });

  it("allows anthropic Bedrock models", () => {
    expect(
      isCacheTtlEligibleProvider(
        "amazon-bedrock",
        "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "anthropic-messages",
      ),
    ).toBe(true);
  });
});

describe("readLastCacheTtlTimestamp", () => {
  it("returns the latest matching timestamp while ignoring projection metadata", () => {
    // Replay only reuses cache TTL entries scoped to the current model target;
    // stale entries for other providers must not reset pruning clocks.
    const sessionManager = {
      getEntries: () => [
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_000_000,
            provider: "anthropic",
            modelId: "claude-sonnet-4-5",
            prunedToolResults: [{ key: "tool:old:42", mode: "hard" }],
            ambiguousToolResultBaseKeys: [],
          },
        },
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_001_000,
            provider: "google",
            modelId: "gemini-3.1-pro-preview",
          },
        },
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            prunedToolResults: [],
            frozenToolResults: [{ key: "tool:new:43", sourceHash: "hash" }],
          },
        },
      ],
    };

    expect(
      readLastCacheTtlTimestamp(sessionManager, {
        provider: "Anthropic",
        modelId: "Claude-Sonnet-4-5",
      }),
    ).toBe(1_700_000_000_000);
  });

  it("ignores unscoped cache-ttl entries when a context filter is requested", () => {
    const sessionManager = {
      getEntries: () => [
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_000_000,
          },
        },
      ],
    };

    expect(
      readLastCacheTtlTimestamp(sessionManager, {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
    ).toBeNull();
  });
});

describe("readLastAssistantCacheTouch", () => {
  const reply = (timestamp: number, model: string, cacheRead: number) => ({
    type: "message",
    message: {
      role: "assistant",
      provider: "anthropic",
      model,
      usage: { cacheRead, cacheWrite: 0 },
      timestamp,
    },
  });

  it("dates the last reply of this model that touched the cache", () => {
    const sessionManager = {
      getEntries: () => [
        reply(1_000, "claude-sonnet-5-5", 900),
        reply(2_000, "claude-sonnet-5-5", 0),
        reply(3_000, "claude-haiku-5-5", 900),
        { type: "message", message: { role: "user", timestamp: 4_000 } },
      ],
    };

    expect(
      readLastAssistantCacheTouch(sessionManager, {
        provider: "Anthropic",
        modelId: "claude-sonnet-5-5",
      }),
    ).toBe(1_000);
    expect(
      readLastAssistantCacheTouch(sessionManager, { provider: "openai", modelId: "gpt-5.4" }),
    ).toBeNull();
  });

  it("reads replies saved by a real session manager", () => {
    const sessionManager = SessionManager.inMemory("/retained");
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1_000 });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      usage: {
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 900,
        totalTokens: 906,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2_000,
    });

    expect(
      readLastAssistantCacheTouch(sessionManager, {
        provider: "anthropic",
        modelId: "claude-sonnet-5-5",
      }),
    ).toBe(2_000);
  });
});
