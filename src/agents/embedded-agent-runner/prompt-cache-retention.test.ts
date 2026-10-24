// Coverage for prompt-cache retention resolution by provider and model API.
import { describe, expect, it } from "vitest";
import {
  resolveCacheKeepWarm,
  resolveCacheRetention,
  resolveRunCacheRetention,
} from "./prompt-cache-retention.js";

describe("prompt cache retention", () => {
  it.each([
    { name: "an idle background session", expected: "short" },
    { name: "a session cached within the hour", touchAgeMs: 59 * 60_000, expected: "long" },
    { name: "another provider API", modelApi: "openai-responses", expected: "long" },
    { name: "the five-minute setting", retention: "short", expected: "short" },
    { name: "a detached chat-triggered run", trigger: "user", detached: true, expected: "short" },
  ] as const)("writes the cache for $name with $expected retention", (params) => {
    const now = 10 * 3_600_000;
    expect(
      resolveRunCacheRetention({
        retention: "long",
        trigger: "cron",
        modelApi: "anthropic-messages",
        conversation: false,
        detached: false,
        ...params,
        lastCacheTouchAt: now - ("touchAgeMs" in params ? params.touchAgeMs : 60 * 60_000),
        now,
      }),
    ).toBe(params.expected);
  });

  it.each([
    { name: "a chat turn on the one-hour cache", keepWarmFor: "12h", expected: 12 * 3_600_000 },
    { name: "a scheduled run", keepWarmFor: "12h", trigger: "cron", expected: undefined },
    { name: "the five-minute cache", keepWarmFor: "12h", retention: "short", expected: undefined },
    {
      name: "another provider API",
      keepWarmFor: "12h",
      modelApi: "openai-responses",
      expected: undefined,
    },
    { name: "an invalid span", keepWarmFor: "soon", expected: undefined },
    { name: "no setting", keepWarmFor: undefined, expected: undefined },
  ] as const)("keeps the cache warm for $name only when configured", (params) => {
    const keepWarm = resolveCacheKeepWarm({
      trigger: "user",
      modelApi: "anthropic-messages",
      retention: "long",
      key: "agent:main:main",
      ...params,
    });
    expect(keepWarm?.maxIdleMs).toBe(params.expected);
    if (keepWarm) {
      expect(keepWarm).toEqual({ key: "agent:main:main", maxIdleMs: params.expected });
    }
  });

  it("forwards native ChatGPT retention", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "openai",
        "openai-chatgpt-responses",
        "gpt-5.6-sol",
        undefined,
        "https://chatgpt.com/backend-api/codex",
      ),
    ).toBe("long");
  });

  it.each([undefined, "none"] as const)(
    "honors explicit retention %s for Anthropic-marker completions without cache keys",
    (cacheRetention) => {
      expect(
        resolveCacheRetention({ cacheRetention }, "custom", "openai-completions", "qwen-plus", {
          cacheControlFormat: "anthropic",
        }),
      ).toBe(cacheRetention);
    },
  );

  it("passes explicit cacheRetention through for direct Google models", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "google",
        "google-generative-ai",
        "gemini-3.1-pro-preview",
      ),
    ).toBe("long");
  });

  it("maps legacy cacheControlTtl for direct Google models", () => {
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "5m" },
        "google",
        "google-generative-ai",
        "gemini-2.5-flash",
      ),
    ).toBe("short");
  });

  it("does not default cacheRetention for direct Google models without explicit config", () => {
    expect(
      resolveCacheRetention(undefined, "google", "google-generative-ai", "gemini-3.1-pro-preview"),
    ).toBeUndefined();
  });

  it("passes explicit cacheRetention through for openai-completions providers when supportsPromptCacheKey (issue #81281)", () => {
    // Regression: prefix-caching OpenAI-compatible backends opt in with
    // supportsPromptCacheKey, so explicit user retention must pass through.
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBe("long");
    expect(
      resolveCacheRetention(
        { cacheRetention: "short" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBe("short");
    expect(
      resolveCacheRetention(
        { cacheRetention: "none" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBe("none");
  });

  it("keeps undocumented cacheRetention values outside the Bedrock runtime contract", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "standard" },
        "amazon-bedrock",
        "openai-completions",
        "us.anthropic.claude-sonnet-4-6",
      ),
    ).toBeUndefined();
  });

  it("does not honor explicit cacheRetention for openai-completions without supportsPromptCacheKey", () => {
    // Providers that route via openai-completions but do not advertise prompt
    // caching must keep retention out of outgoing payloads.
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "amazon.nova-micro-v1:0",
      ),
    ).toBeUndefined();
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: false },
      ),
    ).toBeUndefined();
  });

  it("returns undefined for openai-completions without explicit cacheRetention", () => {
    // Without an explicit user choice, openai-completions providers fall back
    // to the transport-level default ("short") rather than receiving a
    // wrapper-injected value.
    expect(
      resolveCacheRetention(undefined, "omlx-local", "openai-completions", "local_model", {
        supportsPromptCacheKey: true,
      }),
    ).toBeUndefined();
    expect(
      resolveCacheRetention({}, "omlx-local", "openai-completions", "local_model", {
        supportsPromptCacheKey: true,
      }),
    ).toBeUndefined();
  });

  it("does not map legacy cacheControlTtl for openai-completions prompt-cache-key providers", () => {
    // Legacy TTL aliases were Anthropic/Google semantics; OpenAI-compatible
    // completions providers need an explicit cacheRetention value before the
    // wrapper forwards retention to the transport.
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "1h" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBeUndefined();
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "5m" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBeUndefined();
  });
});
