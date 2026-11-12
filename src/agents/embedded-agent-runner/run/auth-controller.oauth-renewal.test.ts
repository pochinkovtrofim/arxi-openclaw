// Coverage for keeping an embedded run's OAuth login fresh while the run lives.
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../auth-profiles.js";

const mocks = vi.hoisted(() => ({
  prepareProviderRuntimeAuth: vi.fn(),
  getApiKeyForModelCore: vi.fn(),
}));

vi.mock("../../../plugins/provider-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../../../plugins/provider-runtime.js")>(
    "../../../plugins/provider-runtime.js",
  )),
  prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
}));

vi.mock("../../model-auth.js", async () => ({
  ...(await vi.importActual<typeof import("../../model-auth.js")>("../../model-auth.js")),
  getApiKeyForModelCore: mocks.getApiKeyForModelCore,
}));

import { createEmbeddedRunAuthController, type EmbeddedRunAuthState } from "./auth-controller.js";

function createMutableAuthControllerHarness(): EmbeddedRunAuthState {
  const model = {
    id: "test-model",
    name: "test-model",
    provider: "custom-openai",
    api: "openai-responses",
    baseUrl: "https://example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 4_000,
  } as Model;
  return {
    models: { runtime: model, effective: model },
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    runtimeAuthRefreshCancelled: false,
    profileIndex: 0,
    thinkLevel: "medium",
  };
}

function createMutableEmbeddedRunAuthController(params: {
  harness: EmbeddedRunAuthState;
  setRuntimeApiKey: (provider: string, apiKey: string) => void;
  profileCandidates?: Array<string | undefined>;
  warn?: (message: string) => void;
}) {
  return createEmbeddedRunAuthController({
    config: undefined,
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    authStore: { version: 1, profiles: {} } as AuthProfileStore,
    authStorage: { setRuntimeApiKey: params.setRuntimeApiKey },
    profileCandidates: params.profileCandidates ?? ["default"],
    initialThinkLevel: "medium",
    attemptedThinking: new Set(),
    fallbackConfigured: false,
    allowTransientCooldownProbe: false,
    provider: "custom-openai",
    modelId: "test-model",
    state: params.harness,
    log: { debug: () => undefined, info: () => undefined, warn: params.warn ?? (() => undefined) },
  });
}

beforeEach(() => {
  mocks.prepareProviderRuntimeAuth.mockReset();
  mocks.getApiKeyForModelCore.mockReset();
});

describe("OAuth login during a long run", () => {
  // Production 2026-11-09: a turn resolved its subscription token two minutes
  // before it expired and reused it for every model call; the provider's
  // "token has expired" 401 ended the turn with a "sign in again" notice
  // although the login itself was fine.
  const expired =
    '401 {"error":{"message":"OAuth access token has expired. Re-authenticate to continue.","type":"authentication_error"}}';
  const oauth = (apiKey: string, expires?: number) => ({
    apiKey,
    mode: "oauth" as const,
    profileId: "anthropic:default",
    source: "profile:anthropic:default",
    ...(expires === undefined ? {} : { expires }),
  });
  const renewal = { profileId: "anthropic:default", lockedProfile: true, forceRefresh: true };

  it("renews the login five minutes before it expires, and again after that", async () => {
    vi.useFakeTimers();
    try {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      const start = Date.now();
      mocks.getApiKeyForModelCore
        .mockResolvedValueOnce(oauth("first-access", start + 8 * 60_000))
        .mockResolvedValueOnce(oauth("second-access", start + 60 * 60_000))
        .mockResolvedValueOnce(oauth("third-access", start + 120 * 60_000));
      mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["anthropic:default"],
      });

      await controller.initializeAuthProfile();
      controller.startOAuthLoginRenewal();
      expect(mocks.getApiKeyForModelCore.mock.calls[0]?.[0]).toMatchObject({
        includeOAuthExpiry: true,
      });
      await vi.advanceTimersByTimeAsync(3 * 60_000 - 1_000);
      expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(2);
      expect(mocks.getApiKeyForModelCore.mock.calls[1]?.[0]).toMatchObject(renewal);
      expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "second-access");

      await vi.advanceTimersByTimeAsync(52 * 60_000);
      expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(3);
      expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "third-access");

      controller.stopRuntimeAuthRefreshTimer();
      await vi.advanceTimersByTimeAsync(240 * 60_000);
      expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed renewal every minute and keeps the current key meanwhile", async () => {
    vi.useFakeTimers();
    try {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      const warn = vi.fn<(message: string) => void>();
      mocks.getApiKeyForModelCore
        .mockResolvedValueOnce(oauth("expiring-access", Date.now() + 2 * 60_000))
        .mockRejectedValueOnce(new Error("temporarily_unavailable"))
        .mockResolvedValueOnce(oauth("renewed-access", Date.now() + 60 * 60_000));
      mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["anthropic:default"],
        warn,
      });

      await controller.initializeAuthProfile();
      controller.startOAuthLoginRenewal();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith("OAuth login renewal failed: temporarily_unavailable");
      expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "expiring-access");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(3);
      expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "renewed-access");
      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a renewal that finishes after the run settled or moved to another login", async () => {
    vi.useFakeTimers();
    try {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      let finishRenewal: (value: unknown) => void = () => undefined;
      mocks.getApiKeyForModelCore
        .mockResolvedValueOnce(oauth("expiring-access", Date.now() + 2 * 60_000))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRenewal = resolve;
            }),
        )
        .mockResolvedValueOnce({ apiKey: "backup-key", mode: "api-key", source: "config" });
      mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["anthropic:default", "backup"],
      });

      await controller.initializeAuthProfile();
      controller.startOAuthLoginRenewal();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(2);

      await controller.applyAuthProfileCandidate("backup", 1);
      controller.stopRuntimeAuthRefreshTimer();
      finishRenewal(oauth("late-access", Date.now() + 60 * 60_000));
      await vi.advanceTimersByTimeAsync(120 * 60_000);

      expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "backup-key");
      expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the login once when the provider refuses it", async () => {
    const harness = createMutableAuthControllerHarness();
    const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
    mocks.getApiKeyForModelCore
      .mockResolvedValueOnce(oauth("expired-access"))
      .mockResolvedValueOnce(oauth("renewed-access"));
    mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey,
      profileCandidates: ["anthropic:default"],
    });

    await controller.initializeAuthProfile();
    controller.startOAuthLoginRenewal();
    expect(harness.runtimeAuthState).toBeNull();

    await expect(controller.maybeRefreshRuntimeAuthForAuthError(expired, false)).resolves.toBe(
      true,
    );
    // Upstream passes the flag explicitly; the first resolution must not force a refresh.
    expect(mocks.getApiKeyForModelCore.mock.calls[0]?.[0]).toMatchObject({ forceRefresh: false });
    expect(mocks.getApiKeyForModelCore.mock.calls[1]?.[0]).toMatchObject(renewal);
    expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "renewed-access");

    // The retried attempt carries the flag: a second refusal ends the turn.
    await expect(controller.maybeRefreshRuntimeAuthForAuthError(expired, true)).resolves.toBe(
      false,
    );
    expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(2);
  });

  it("keeps the refusal when the renewal fails", async () => {
    const harness = createMutableAuthControllerHarness();
    const warn = vi.fn<(message: string) => void>();
    mocks.getApiKeyForModelCore
      .mockResolvedValueOnce(oauth("expired-access"))
      .mockRejectedValueOnce(new Error("invalid_grant"));
    mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey: vi.fn(),
      profileCandidates: ["anthropic:default"],
      warn,
    });

    await controller.initializeAuthProfile();
    controller.startOAuthLoginRenewal();
    await expect(controller.maybeRefreshRuntimeAuthForAuthError(expired, false)).resolves.toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      "OAuth login renewal after an auth error failed: invalid_grant",
    );
  });

  it("does not renew an API key or a non-auth failure", async () => {
    const harness = createMutableAuthControllerHarness();
    mocks.getApiKeyForModelCore.mockResolvedValue({
      apiKey: "platform-key",
      mode: "api-key",
      source: "config",
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey: vi.fn(),
    });

    await controller.initializeAuthProfile();
    controller.startOAuthLoginRenewal();
    await expect(controller.maybeRefreshRuntimeAuthForAuthError(expired, false)).resolves.toBe(
      false,
    );
    await expect(
      controller.maybeRefreshRuntimeAuthForAuthError("429 rate limit exceeded", false),
    ).resolves.toBe(false);
    expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(1);
  });
});
