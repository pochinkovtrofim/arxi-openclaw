import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

const observed = vi.hoisted(() => ({ info: vi.fn(), register: vi.fn(), events: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  embeddedAgentLog: { info: observed.info, warn: vi.fn(), debug: vi.fn() },
  formatErrorMessage: String,
}));
vi.mock("./attempt-diagnostics.js", () => ({
  createCodexModelCallDiagnosticEmitter: () => ({ setRequestPayloadBytes: vi.fn() }),
  utf8JsonByteLength: () => 1,
}));
vi.mock("./binding-connection.js", () => ({ assertCodexSessionRuntimeOwnership: vi.fn() }));
vi.mock("./client-runtime.js", () => ({
  prepareCodexWorkspaceReferences: () => ({ include: "", accepted: vi.fn() }),
}));
vi.mock("./explicit-skill-input.js", () => ({ resolveCodexExplicitSkillInputs: async () => [] }));
vi.mock("./inference-routing.js", () => ({
  getCodexInferenceThread: () => ({ context: { register: observed.register } }),
}));
vi.mock("./run-attempt-lifecycle.js", () => ({
  emitCodexAppServerEvent: observed.events,
  withCodexAppServerFastModeServiceTier: (value: unknown) => value,
}));
vi.mock("./thread-lifecycle.js", () => ({ buildTurnStartParams: () => ({ input: [] }) }));
vi.mock("./trajectory.js", () => ({ recordCodexTrajectoryContext: vi.fn() }));
vi.mock("./turn-params.js", () => ({ buildCodexParentLocalInstructions: () => "" }));
vi.mock("./rate-limit-cache.js", () => ({ readCodexRateLimitsRevision: () => 0 }));

beforeEach(() => {
  observed.info.mockReset();
  observed.events.mockReset();
  observed.register.mockReset();
  observed.register.mockReturnValue({ generation: "fixture-generation", release: vi.fn() });
});

const privatePacket = "Private packet: Simona's unpublished owner source facts";
const privateRules = "Private USER rule: never disclose the passport";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function productionCallback(needsExpansion = false) {
  const params = {
    runId: "external:receipt-proof",
    sessionKey: "private-session-key",
    sessionId: "private-session-id",
    provider: "openai",
    modelId: "gpt-6.1-sol",
    model: { api: "openai-codex-responses" },
    hostCapabilities: { assertActive: vi.fn() },
  };
  const resources = {
    prompt: {
      context: {
        runtime: {
          connection: {
            params,
            usesSupervisionConnection: false,
            appServer: { start: { transport: "stdio" } },
            mutable: { pluginAppServer: {} },
            runAbortController: new AbortController(),
            assertCurrent: vi.fn(),
          },
          runtimeParams: params,
          effectiveRuntimeProviderId: "openai",
          effectiveRuntimeModelId: "gpt-6.1-sol",
          effectiveContextTokenBudget: 80_000,
        },
        attemptTools: { tools: [], toolBridge: { availableTools: [], availableSpecs: [] } },
        workspaceBootstrapContext: { promptContext: "" },
        personalPromptState: {
          packet: { text: privatePacket, budgetTokens: 8_000, needsExpansion },
          mandatorySourcesComplete: true,
          staticPolicies: [],
        },
        hookContext: {},
        promptState: { ordinarySessionSegments: [] },
        baseDeveloperInstructions: "",
      },
      turnState: {
        codexTurnPromptText: privatePacket,
        promptBuild: { developerInstructions: privateRules },
      },
      buildRenderedCodexDeveloperInstructions: () => privateRules,
      codexModelInputHistoryMessages: [],
      contextImageGroups: [],
      refreshWorkspaceReferences: vi.fn(),
      setParentLocalEgress: vi.fn(),
    },
    state: {
      client: {
        request: async () => ({ turn: { id: "turn-proof", status: "inProgress", items: [] } }),
      },
      codexExecutionCwd: "/fixture",
      thread: { threadId: "thread-proof", model: "gpt-6.1-sol", lifecycle: { action: "created" } },
    },
    releaseCurrentRoute: vi.fn(),
  } as unknown as CodexAttemptResources;
  const prepared = await prepareCodexAttemptTurnRequest(
    resources,
    { state: {} } as unknown as CodexAttemptTurnState,
    async () => ({ armTurn: vi.fn(), cancelTurn: vi.fn() }),
    async () => true,
  );
  await prepared.startCodexTurn();
  const registration = observed.register.mock.calls[0]?.[0];
  if (!registration) {
    throw new Error("production did not register its personal pre-egress gate");
  }
  return registration.preEgressGate as (value: Record<string, unknown>) => void;
}

it("production pre-egress callback durably logs only receipt metadata for model-bound allowance and refusal", async () => {
  const gate = await productionCallback();
  const initial = {
    model: "gpt-6.1-sol",
    instructions: privateRules,
    input: [{ role: "user", content: privatePacket }],
  };
  gate(initial);
  expect(observed.info).toHaveBeenNthCalledWith(
    1,
    "codex personal context pre-egress",
    expect.objectContaining({
      runId: "external:receipt-proof",
      model: "gpt-6.1-sol",
      requestSha256: sha(JSON.stringify(initial)),
      packetSha256: sha(privatePacket),
      status: "within_bound",
      exactPersonalTokens: null,
      budgetTokens: 8_000,
      requestSequence: 1,
      cumulativeToolOutputs: 0,
    }),
  );
  const continuation = {
    model: "gpt-6.1-sol",
    previous_response_id: "response-proof",
    input: [
      {
        type: "function_call_output",
        call_id: "read-proof",
        output: "Private email content".repeat(600),
      },
    ],
  };
  expect(() => gate(continuation)).toThrow("needs_expansion");
  expect(observed.info).toHaveBeenNthCalledWith(
    2,
    "codex personal context pre-egress",
    expect.objectContaining({
      requestSha256: sha(JSON.stringify(continuation)),
      status: "needs_expansion",
      reason: "personal_context_over_bound",
      requestSequence: 2,
      newToolOutputs: 1,
      cumulativeToolOutputs: 1,
    }),
  );
  const logged = JSON.stringify(observed.info.mock.calls);
  for (const sensitive of [
    privatePacket,
    privateRules,
    "Private email content",
    "private-session-key",
    "private-session-id",
  ]) {
    expect(logged).not.toContain(sensitive);
  }
  expect(observed.info.mock.calls[1]?.[1].upperBoundUtf8Bytes).toBeGreaterThan(8_000);
  expect(
    observed.events.mock.calls.some(
      ([, event]) => event.data.phase === "personal_context_pre_egress",
    ),
  ).toBe(true);
});

it("production pre-egress callback retains a content-free mandatory source refusal receipt", async () => {
  const gate = await productionCallback(true);
  expect(() => gate({ model: "gpt-6.1-sol", input: [] })).toThrow("needs_expansion");
  expect(observed.info).toHaveBeenCalledWith(
    "codex personal context pre-egress",
    expect.objectContaining({
      runId: "external:receipt-proof",
      status: "needs_expansion",
      reason: "mandatory_source_omitted",
      model: "gpt-6.1-sol",
      budgetTokens: 8_000,
    }),
  );
  expect(JSON.stringify(observed.info.mock.calls)).not.toContain(privatePacket);
});
