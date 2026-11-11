// Coverage for overlapping independent system prompt section reads.
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { buildBootstrapBudgetState } from "../../bootstrap-budget.js";
import type { AgentTool } from "../../runtime/index.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const reads = vi.hoisted(() => ({
  started: [] as string[],
  memory: undefined as Promise<undefined> | undefined,
  watched: undefined as Promise<undefined> | undefined,
}));

vi.mock("../../../plugins/providers.runtime-core.js", () => ({
  createProviderRegistryResolver: () => ({
    isPluginProvidersLoadInFlight: () => false,
    resolvePluginProvidersCore: () => {
      throw new Error("Prompt fixture unexpectedly discovered provider runtime");
    },
  }),
}));
vi.mock("../../memory-prompt-prepare.js", () => ({
  prepareAgentMemoryPrompt: () => {
    reads.started.push("memory");
    return reads.memory;
  },
}));
vi.mock("../../watched-sessions-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../watched-sessions-prompt.js")>()),
  prepareWatchedSessionsPromptAsync: () => {
    reads.started.push("watched");
    return reads.watched;
  },
}));

const admissions: Array<ReturnType<typeof prepareSystemAgentRunAdmission>> = [];
afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  reads.started.length = 0;
});

describe("embedded attempt system prompt preparation", () => {
  it("starts the memory and watched-session reads together", async () => {
    const { prepareEmbeddedAttemptSystemPrompt } =
      await import("./attempt-system-prompt-prepare.js");
    const memory = createDeferred<undefined>();
    const watched = createDeferred<undefined>();
    reads.memory = memory.promise;
    reads.watched = watched.promise;
    const admission = prepareSystemAgentRunAdmission({}, "prompt-overlap", "main", "test");
    admissions.push(admission);
    const tool: AgentTool = {
      name: "read",
      label: "read",
      description: "read",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };
    const attempt = {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      model: makeProviderModelFixture({
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
      promptMode: "full",
      sessionId: "prompt-overlap",
      sessionKey: "agent:main:prompt-overlap",
      workspaceDir: "/tmp/openclaw",
      config: {},
      admittedRunContext: await admission.admit("embedded"),
    } as EmbeddedRunAttemptParams;

    const pending = prepareEmbeddedAttemptSystemPrompt({
      attempt,
      activeContextEngine: undefined,
      bootstrap: {
        ...buildBootstrapBudgetState({ files: [] }),
        bootstrapMode: "full",
        contextFiles: [],
        bootstrapInjectionStats: [],
        shouldRecordCompletedBootstrapTurn: false,
        workspaceNotes: [],
      },
      capabilityToolNames: new Set(["read"]),
      effectiveTools: [tool],
      setup: createAttemptSetupFixture({
        effectiveCwd: "/tmp/openclaw",
        effectiveWorkspace: "/tmp/openclaw",
        getProviderRuntimeHandle: () => ({
          provider: attempt.provider,
          modelId: attempt.modelId,
          prepared: true,
        }),
        sandboxSessionKey: attempt.sessionKey,
      }),
      isRawModelRun: false,
      modelToolsEnabled: true,
      skillsPrompt: "",
      toolSearchDirectoryEnabled: false,
      toolSearchRuntimeConfig: attempt.config,
    });

    await vi.waitFor(() => expect(reads.started).toEqual(["memory", "watched"]));
    memory.resolve(undefined);
    watched.resolve(undefined);
    await expect(pending).resolves.toEqual(
      expect.objectContaining({ prepareToolPrompt: expect.any(Function) }),
    );
  });
});
