import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OAuthCredential } from "../../auth-profiles.js";
import { testing as externalAuthTesting } from "../../auth-profiles/external-auth.test-support.js";
import type { AgentHarness } from "../../harness/types.js";
import { prepareAgentRuntimeAuth } from "../../runtime-plan/prepare-auth.js";
import type { resolveModelAsync as ResolveModelAsync } from "../model.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";
import { testing as authPlanTesting } from "./auth-plan.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const resolveModelAsyncMock = vi.hoisted(() => vi.fn());
type RuntimeModel = NonNullable<Awaited<ReturnType<typeof ResolveModelAsync>>["model"]>;

const readCodexCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(_options?: unknown) => OAuthCredential | null>(() => null),
);

vi.mock("../../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));

vi.mock("../model.js", () => ({
  resolveModelAsync: resolveModelAsyncMock,
}));

describe("embedded run auth plan provider pin", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "openclaw-auth-pin-"));
    readCodexCliCredentialsCachedMock.mockReset().mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires: Date.now() + 30 * 60_000,
    });
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(async () => {
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    vi.unstubAllEnvs();
    await rm(agentDir, { recursive: true, force: true });
  });

  it("keeps ambient Codex OAuth behind an OpenAI api-key pin", () => {
    const config = {
      models: {
        providers: {
          openai: { auth: "api-key", baseUrl: "", models: [] },
        },
      },
    } as OpenClawConfig;
    vi.stubEnv("OPENAI_API_KEY", "platform-api-key");

    const authProfileStore = authPlanTesting.loadEmbeddedRunAuthProfileStore({
      agentDir,
      config,
      externalCliProviderIds: ["openai"],
    });
    expect(authProfileStore.profiles["openai:default"]).toBeUndefined();
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      config,
      env: process.env,
      agentDir,
      authProfileStore,
    });

    expect(prepared.attempts[0]).toMatchObject({
      kind: "direct",
      plan: {
        selectedAuthMode: "api-key",
        modelRoute: {
          authRequirement: "api-key",
        },
      },
    });
  });

  it("keeps the selected Codex runtime while rematerializing OAuth-scoped model metadata", async () => {
    const config = {
      models: {
        providers: {
          openai: {
            auth: "oauth",
            apiKey: "configured-oauth-token",
            baseUrl: "",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const model = {
      provider: "openai",
      id: "runtime-only-test-model",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as RuntimeModel;
    const codexHarness = { id: "codex" } as AgentHarness;
    const authStorage = {};
    const modelRegistry = {};
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
    resolveModelAsyncMock.mockReset().mockResolvedValue({ model });

    const prepared = await prepareEmbeddedRunAuthPlan({
      runParams: {
        agentId: "main",
        config,
        workspaceDir: agentDir,
      } as RunEmbeddedAgentParams,
      provider: "openai",
      modelId: "runtime-only-test-model",
      model,
      agentDir,
      workspaceDir: agentDir,
      nativeModelOwned: false,
      authStorage: authStorage as never,
      modelRegistry: modelRegistry as never,
      getAgentHarness: () => codexHarness,
      setAgentHarness: () => {},
      getRuntimeModel: () => model,
      getEffectiveModel: () => model,
      applyResolvedRuntimeModel: () => {},
      selectHarnessForPreparedAttempts: () => codexHarness,
    });
    await prepared.materializeAuthPlanUncached(prepared.activePreparedAuthPlan, true);

    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai",
      "runtime-only-test-model",
      agentDir,
      {
        models: {
          providers: {
            openai: {
              ...config.models!.providers!.openai,
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
          },
        },
      },
      expect.objectContaining({
        agentRuntimeId: "codex",
        authStorage,
        modelRegistry,
        authProfileId: undefined,
        authProfileMode: "oauth",
        skipAgentDiscovery: true,
      }),
    );
  });
});
