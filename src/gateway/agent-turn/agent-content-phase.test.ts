import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import * as mediaProbe from "../../media/media-probe.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createChatRunState } from "../server-chat-state.js";
import * as audioUnderstanding from "./agent-audio-understanding.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import type { AgentTurnContext } from "./types.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

it.each([
  { name: "main", agentId: "main", replaceDuringRead: false },
  { name: "work", agentId: "work", replaceDuringRead: false },
  { name: "replacement work", agentId: "work", replaceDuringRead: true },
])(
  "admits images using the explicit $name global session owner",
  async ({ agentId, replaceDuringRead }) => {
    state = await createOpenClawTestState({ label: "agent-content-owner" });
    const { stateDir, workspaceDir } = state;
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { model: "mock-openai/main-vision" },
          work: { model: "mock-openai/work-vision" },
        },
        defaults: { workspace: state.workspaceDir },
      },
      plugins: { enabled: false },
      session: { scope: "global" },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    if (replaceDuringRead) {
      const scope = { agentId, sessionKey: "global", env: state.env };
      await replaceSessionEntry(scope, {
        sessionId: "previous-text-session",
        lifecycleRevision: "previous-lifecycle",
        updatedAt: 1,
        providerOverride: "mock-openai",
        modelOverride: "text-only",
      });
      const read = sessionEntryReads.withSessionEntryReadOnlyInWorker;
      vi.spyOn(sessionEntryReads, "withSessionEntryReadOnlyInWorker").mockImplementationOnce(
        async (...args) => {
          await replaceSessionEntry(scope, {
            sessionId: "replacement-vision-session",
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: 2,
            providerOverride: "mock-openai",
            modelOverride: `${agentId}-vision`,
          });
          return await read(...args);
        },
      );
    }
    const loadGatewayModelCatalogSnapshot = vi.fn<
      AgentTurnContext["loadGatewayModelCatalogSnapshot"]
    >(async (params) => ({
      agentId: params?.agentId ?? agentId,
      agentDir: stateDir,
      workspaceDir,
      catalogComplete: true,
      config: cfg,
      entries: [
        {
          id: "text-only",
          name: "Synthetic text model",
          provider: "mock-openai",
          input: ["text"],
        } satisfies ModelCatalogEntry,
        {
          id: `${params?.agentId}-vision`,
          name: "Synthetic vision model",
          provider: "mock-openai",
          input: ["text", "image"],
        } satisfies ModelCatalogEntry,
      ],
      routeVariants: [],
    }));
    const context: AgentTurnContext = {
      addChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      deps: {},
      getRuntimeConfig: () => cfg,
      trackExecution: async (work) => await work(),
      getSessionEventSubscriberConnIds: () => new Set(),
      loadGatewayModelCatalog: vi.fn(async () => []),
      loadGatewayModelCatalogSnapshot,
      logGateway: createSubsystemLogger("test/agent-content"),
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => undefined),
    };
    const respond = vi.fn();
    const steps: string[] = [];
    const result = await prepareAgentContentPhase({
      onStep: (step) => steps.push(step),
      request: {
        message: "Inspect this synthetic pixel",
        agentId,
        sessionKey: "global",
        idempotencyKey: `image-${agentId}`,
      },
      cfg,
      context,
      respond,
      isRawModelRun: false,
      requestedSessionKeyRaw: "global",
      requestedSessionKey: "global",
      agentId,
      knownAgents: ["main", "work"],
      normalizedAttachments: [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "pixel.png",
          content:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
    // The trace splits the content stage at each step, in order.
    expect(steps).toEqual([
      "model_capabilities",
      "voice_wake_routing",
      "attachment_parse",
      "audio_understanding",
      "media_probe",
    ]);
    expect(result).toMatchObject({
      agentId,
      requestedSessionKey: "global",
      images: [expect.objectContaining({ mimeType: "image/png" })],
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledExactlyOnceWith({
      agentId,
      readOnly: true,
    });
  },
);

it("transcribes a voice note while its duration probe runs", async () => {
  state = await createOpenClawTestState({ label: "agent-content-voice" });
  const { stateDir, workspaceDir } = state;
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { enabled: false },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  let finishProbe!: () => void;
  const probeHeld = new Promise<void>((resolve) => {
    finishProbe = resolve;
  });
  vi.spyOn(mediaProbe, "probeMediaFilesWithinBudget").mockImplementation(async (inputs) => {
    await probeHeld;
    return inputs.map(() => ({ durationMs: 4200 }));
  });
  // Transcription starts while the probe is held; awaiting the probe first
  // would never reach it.
  vi.spyOn(audioUnderstanding, "applyAgentAudioUnderstanding").mockImplementation(async () => {
    finishProbe();
    return { applied: true, message: "synthetic transcript" };
  });
  const context: AgentTurnContext = {
    addChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    deps: {},
    getRuntimeConfig: () => cfg,
    trackExecution: async (work) => await work(),
    getSessionEventSubscriberConnIds: () => new Set(),
    loadGatewayModelCatalog: vi.fn(async () => []),
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
      agentId: "main",
      agentDir: stateDir,
      workspaceDir,
      catalogComplete: true,
      config: cfg,
      entries: [],
      routeVariants: [],
    })),
    logGateway: createSubsystemLogger("test/agent-content-voice"),
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  };
  const respond = vi.fn();
  const result = await prepareAgentContentPhase({
    request: { message: "", agentId: "main", sessionKey: "main", idempotencyKey: "voice-note" },
    cfg,
    context,
    respond,
    isRawModelRun: false,
    requestedSessionKeyRaw: "main",
    requestedSessionKey: "main",
    agentId: "main",
    knownAgents: ["main"],
    normalizedAttachments: [
      {
        type: "audio",
        mimeType: "audio/mpeg",
        fileName: "voice.mp3",
        content: Buffer.from("audio-fixture").toString("base64"),
      },
    ],
  });
  expect(respond).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    message: "synthetic transcript",
    media: [expect.objectContaining({ durationMs: 4200 })],
  });
  expect(result).not.toHaveProperty("probedMedia");
});
