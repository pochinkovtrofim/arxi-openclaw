import path from "node:path";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { expect, it, onTestFinished, vi } from "vitest";
import type { RawData } from "ws";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createAttemptNestedToolActivityState } from "../agents/embedded-agent-runner/run/attempt-nested-tool-activity.js";
import { prepareEmbeddedAttemptStream } from "../agents/embedded-agent-runner/run/attempt-stream-prepare.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../agents/embedded-agent-runner/run/types.js";
import { clearActiveEmbeddedRun } from "../agents/embedded-agent-runner/runs.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  streamMocks,
} from "../agents/sessions/agent-session-loop-correctness.test-support.js";
import { makeEmbeddedRunnerAttempt } from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { createDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { rawDataToString } from "../infra/ws.js";
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import {
  agentCommandMock,
  connectOk,
  dispatchInboundMessageMock,
  embeddedRunMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

const runAttempt = vi.hoisted(() =>
  vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>(),
);

// The real harness selects the runtime and prepares its authority before this
// model-execution boundary. The test never creates a reply operation or hash.
vi.mock("../agents/embedded-agent-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: runAttempt,
}));

const browserOrigin = "https://agent-steer.example.test";
const gatewayToken = "synthetic-agent-steer-gateway-token";
let harness: Awaited<ReturnType<typeof startServerWithClient>>;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;

type AgentResponse = {
  type: string;
  id: string;
  ok: boolean;
  payload?: { runId?: string; status?: string };
  error?: { message?: string };
};

installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      testState.gatewayControlUi = { allowedOrigins: [browserOrigin] };
      harness = await startServerWithClient(gatewayToken, {
        controlUiEnabled: true,
        wsHeaders: { origin: browserOrigin },
      });
      await connectOk(harness.ws, {
        token: gatewayToken,
        browserOrigin,
        prePairDevice: true,
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        scopes: ["operator.read", "operator.write", "operator.admin"],
      });
    } finally {
      capture.mockRestore();
    }
  },
  cleanup: async () => {
    harness?.ws.close();
    await harness?.server.close();
    await closeSkillsWatchers(true);
    harness?.envSnapshot.restore();
  },
});

it("adds the host's follow-up to the run it waits on, exactly once", async ({ signal }) => {
    const sessionKey = `agent:main:direct-steering-agent-steer`;
    const sessionId = `direct-steering-session-agent-steer`;
    const runId = "external:agent-steer-original";
    const model: Model = {
      id: "mock-1",
      name: "Steering fixture",
      provider: "steering-fixture",
      api: "openai-responses",
      baseUrl: "https://steering.example.test",
      reasoning: false,
      input: ["text"],
      contextWindow: 16_000,
      maxTokens: 2_048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    testState.sessionStorePath = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    testState.agentConfig = {
      model: { primary: `${model.provider}/${model.id}` },
      thinkingDefault: "off",
      compaction: { enabled: false },
    };
    testState.gatewayAuth = { mode: "token", token: gatewayToken };
    testState.gatewayControlUi = { allowedOrigins: [browserOrigin] };
    const config = getRuntimeConfig();
    await writeConfigFile({
      ...config,
      plugins: { ...config.plugins, enabled: false },
      models: {
        providers: {
          [model.provider]: {
            api: "openai-responses",
            apiKey: "synthetic-steering-key",
            baseUrl: model.baseUrl,
            models: [
              {
                id: model.id,
                name: model.name,
                reasoning: model.reasoning,
                input: model.input,
                cost: model.cost,
                contextWindow: model.contextWindow,
                maxTokens: model.maxTokens,
              },
            ],
          },
        },
      },
    });
    const discovery = await import("../agents/agent-model-discovery.js");
    const actualDiscovery = await vi.importActual<
      typeof import("../agents/agent-model-discovery.js")
    >("../agents/agent-model-discovery.js");
    const discoverySpy = vi
      .spyOn(discovery, "discoverModels")
      .mockImplementation(actualDiscovery.discoverModels);
    onTestFinished(() => discoverySpy.mockRestore());
    await prepareGatewayReplyRuntimeForTest({ force: true });
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
          agentHarnessId: "openclaw",
          permissionMode: "full",
          restartRecoveryTerminalRunIds: ["unrelated-completed-source"],
        },
      },
    });

    const command = await import("../agents/agent-command.js");
    agentCommandMock.mockImplementation((...args) =>
      command.agentCommandFromGatewayIngress(
        ...(args as Parameters<typeof command.agentCommandFromGatewayIngress>),
      ),
    );
    const releaseModel = createDeferred();
    const modelStarted = createDeferred();
    const ownerReady = createDeferred<{
      attempt: EmbeddedRunAttemptParams;
      handle: ReturnType<typeof prepareEmbeddedAttemptStream>["queueHandle"];
    }>();
    const disposition = createDeferred<"steered" | "followup">();
    const steerCalls: unknown[][] = [];
    dispatchInboundMessageMock.mockImplementation(async () => {
      disposition.resolve("followup");
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    runAttempt.mockImplementation(async (attempt) => {
      const modelStream = createAssistantMessageEventStream();
      streamMocks.streamSimple
        .mockImplementation(() =>
          createAssistantResultStream(
            createAssistant(attempt.model, [{ type: "text", text: "Correction applied." }]),
          ),
        )
        .mockImplementationOnce(() => {
          modelStarted.resolve();
          return modelStream;
        });
      const { session } = await createTestSession({ model: attempt.model });
      const steer = session.steer.bind(session);
      vi.spyOn(session, "steer").mockImplementation(async (...args) => {
        const result = await steer(...args);
        steerCalls.push(args);
        disposition.resolve("steered");
        return result;
      });
      const controller = new AbortController();
      const prepared = prepareEmbeddedAttemptStream({
        attempt,
        agentSession: {
          activeSession: session,
          hookRunner: null,
          clientToolCallSlots: [],
          hasDeliveredSourceReply: () => false,
          markSourceReplyDelivered: vi.fn(),
          builtinToolNames: new Set(),
          coreBuiltinToolNames: new Set(),
          replaySafeToolNames: new Set(),
          codeModeExecToolNames: new Set(),
          sideEffectToolOwners: new Map(),
          trustedLocalMediaToolNames: new Set(),
        },
        hookAgentId: attempt.agentId ?? "main",
        diagnosticTrace: createDiagnosticTraceContext(),
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({ sessionId, runId }),
        nestedToolActivityState: createAttemptNestedToolActivityState(),
        isReplaySafeTool: () => false,
        runAbortController: controller,
        abortRun: (_timeout, reason) => controller.abort(reason),
        markExternalAbort: vi.fn(),
        getRunState: () => ({
          aborted: controller.signal.aborted,
          promptError: undefined,
          timedOut: false,
          yieldDetected: false,
        }),
        onBlockReply: undefined,
        onBlockReplyFlush: undefined,
      });
      embeddedRunMock.activeIds.add(sessionId);
      const prompt = session.prompt(attempt.prompt);
      try {
        await modelStarted.promise;
        ownerReady.resolve({ attempt, handle: prepared.queueHandle });
        await releaseModel.promise;
        const assistant = createAssistant(attempt.model, [{ type: "text", text: "Completed." }]);
        modelStream.push({ type: "done", reason: "stop", message: assistant });
        modelStream.end();
        await prompt;
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: sessionId,
          lastAssistant: assistant,
          assistantTexts: ["Completed."],
          messagesSnapshot: session.messages,
        });
      } finally {
        prepared.subscription.unsubscribe();
        clearActiveEmbeddedRun(sessionId, prepared.queueHandle, sessionKey, attempt.sessionFile);
        embeddedRunMock.activeIds.delete(sessionId);
        session.dispose();
      }
    });
    const requestId = "original-agent-steer";
    // The fixture holds the run open until release, so observe its terminal without a budget.
    const terminal = createDeferred<AgentResponse>();
    const observeTerminal = (data: RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as AgentResponse;
      if (frame.type === "res" && frame.id === requestId && frame.payload?.status !== "accepted") {
        terminal.resolve(frame);
      }
    };
    harness.ws.on("message", observeTerminal);
    onTestFinished(() => harness.ws.off("message", observeTerminal));
    harness.ws.send(
      JSON.stringify({
        type: "req",
        id: requestId,
        method: "agent",
        params: {
          sessionKey,
          message: "Find me a hotel in Girona for Friday.",
          deliver: false,
          idempotencyKey: runId,
        },
      }),
    );
    try {
      await withinTest(ownerReady.promise, signal);
      const other = await rpcReq(harness.ws, "agent.steer", {
        sessionKey,
        message: "Under 120 euros, please.",
        expectedRunId: "external:someone-else",
        idempotencyKey: "follow-up-mismatch",
      });
      expect(other.payload).toEqual({
        status: "not_steerable",
        reason: "run_mismatch",
        activeRunId: runId,
      });
      const idle = await rpcReq(harness.ws, "agent.steer", {
        sessionKey: "agent:main:agent-steer-idle",
        message: "Under 120 euros, please.",
        expectedRunId: runId,
        idempotencyKey: "follow-up-idle",
      });
      expect(idle.payload).toMatchObject({ status: "not_steerable" });
      const request = {
        sessionKey,
        message: "Under 120 euros, please.",
        expectedRunId: runId,
        idempotencyKey: "follow-up-steered",
      };
      // The steer answers once the run reads the follow-up, after its current model turn.
      const steeredReply = rpcReq(harness.ws, "agent.steer", request);
      expect(await withinTest(disposition.promise, signal)).toBe("steered");
      releaseModel.resolve();
      const steered = await steeredReply;
      expect(steered.ok, JSON.stringify(steered.error)).toBe(true);
      expect(steered.payload).toEqual({ status: "steered", runId });
      const retried = await rpcReq(harness.ws, "agent.steer", request);
      expect(retried.payload).toEqual({ status: "steered", runId });
      expect(steerCalls).toHaveLength(1);
      expect(JSON.stringify(steerCalls[0])).toContain("Under 120 euros, please.");
      const reused = await rpcReq(harness.ws, "agent.steer", { ...request, message: "Other text" });
      expect(reused.ok).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseModel.resolve();
      const done = await withinTest(terminal.promise, signal);
      expect(done.ok, JSON.stringify(done.error)).toBe(true);
    }
    const after = await rpcReq(harness.ws, "agent.steer", {
      sessionKey,
      message: "And breakfast included.",
      expectedRunId: runId,
      idempotencyKey: "follow-up-after-terminal",
    });
    expect(after.payload).toMatchObject({ status: "not_steerable" });
});
