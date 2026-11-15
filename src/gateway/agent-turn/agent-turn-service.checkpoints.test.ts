import { afterEach, beforeEach, expect, it, vi } from "vitest";

const clock = vi.hoisted(() => ({ tick: (_ms: number) => {} }));
const startExecution = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const admission = vi.hoisted(() => ({ outcome: false }));

/** Each mocked step takes a distinct, known time on the fake clock. */
const takes = <T>(ms: number, value: T) => {
  return async () => {
    clock.tick(ms);
    return value;
  };
};

vi.mock("./agent-dedupe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-dedupe.js")>()),
  replayAgentTurnIfCached: () => false,
}));
vi.mock("./agent-steer.js", () => ({ replaySteeredAgentTurn: () => false }));
vi.mock("./agent-dedupe-lifecycle.js", () => ({
  createAgentDedupeLifecycle: () => ({
    reserve: vi.fn(),
    bindSessionTarget: vi.fn(),
    clearUnaccepted: vi.fn(),
    assertReservationCurrent: vi.fn(),
    markAccepted: vi.fn(),
    ownedReservationKeys: vi.fn(),
    handlePreparationFailure: () => (error: unknown) => {
      throw error;
    },
  }),
}));
vi.mock("./agent-request-routing.js", () => ({
  prepareAgentRequestRouting: takes(10, { requestedSessionKey: "agent:main:main", agentId: "main" }),
}));
vi.mock("../../config/sessions/session-actor-storage-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-actor-storage-binding.js")>()),
  acquireSessionActorStorage: takes(20, { actor: { release: async () => {} } }),
}));
vi.mock("./agent-content-phase.js", () => ({
  prepareAgentContentPhase: takes(30, {
    agentId: "main",
    requestedSessionKey: "agent:main:main",
    offloadedRefs: [],
    message: "",
    effectiveTranscriptInputText: "",
  }),
}));
vi.mock("../server-methods/agent-reset-phase.js", () => ({
  runAgentResetPhase: takes(5, {
    requestedSessionKey: "agent:main:main",
    effectiveTranscriptInputText: "",
    message: "",
  }),
}));
vi.mock("../server-methods/agent-session-prepare.js", () => ({
  prepareAgentSession: takes(40, {
    cfg: {},
    canonicalKey: "agent:main:main",
    canonicalSessionAgentId: "main",
    sessionId: "s1",
    freshChild: true,
  }),
}));
vi.mock("../server-methods/agent-session-patch.js", () => ({ buildAgentSessionPatch: vi.fn() }));
vi.mock("../operator-role-policy.js", () => ({ authorizeGatewaySessionCreation: () => undefined }));
vi.mock("../session-sharing.js", () => ({
  authorizeResolvedSessionMutationAsync: async () => undefined,
}));
vi.mock("../skill-library-session.js", () => ({
  prepareSkillLibrarySessionCreation: async () => undefined,
}));
vi.mock("../session-creation-provenance.js", () => ({
  resolveAgentRunSessionCreation: () => undefined,
}));
vi.mock("../server-methods/agent-cron-continuation.js", () => ({
  createCronContinuationController: () => ({
    releaseWithRecovery: async () => {},
    setClaim: vi.fn(),
  }),
}));
vi.mock("./agent-admission-controller.js", () => ({
  createAgentAdmissionController: () => ({
    release: vi.fn(),
    assertAllowed: vi.fn(),
    acquire: takes(50, undefined),
    respondToOutcome: () => admission.outcome,
    hasOutcome: () => false,
  }),
}));
vi.mock("./agent-session-persist.js", () => ({
  persistAgentSessionPhase: takes(60, { resolvedSessionId: "s1" }),
}));
vi.mock("./agent-delivery-phase.js", () => ({
  resolveAgentDeliveryPhase: takes(70, { activeSessionAgentId: "main" }),
}));
vi.mock("./agent-run-admission-phase.js", () => ({
  prepareAgentRunDispatch: takes(80, { userTurn: {} }),
}));
vi.mock("./agent-run-execution-phase.js", () => ({ startAgentRunExecution: startExecution }));
vi.mock("../../agents/main-session-recovery/main-session-recovery-store.js", () => ({
  releaseMainSessionRecoveryOwner: async () => undefined,
}));
vi.mock("../../agents/main-session-recovery/main-session-recovery-owner-release.js", () => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

import { createAgentTurnService } from "./agent-turn-service.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
  clock.tick = (ms) => vi.advanceTimersByTime(ms);
  admission.outcome = false;
  startExecution.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function start() {
  const service = createAgentTurnService({
    context: {
      trackExecution: (run: () => Promise<void>) => run(),
      logGateway: { warn: vi.fn() },
    },
    isWebchatConnect: () => false,
  } as never);
  return service.startTurn({
    preflight: {
      request: {},
      cfg: {},
      runId: "run-1",
      normalizedSpawned: {},
      agentDedupeKeys: [],
    },
    principal: null,
    io: { emitAcceptance: vi.fn() },
    rpcReceivedAt: 1_000,
  } as never);
}

it("hands the moment each Gateway step finished to the run, in order", async () => {
  await start();
  await vi.waitFor(() => expect(startExecution).toHaveBeenCalledOnce());
  const params = startExecution.mock.calls[0]?.[0] as {
    rpcReceivedAt: number;
    rpcCheckpoints: Array<{ stage: string; at: number }>;
  };
  expect(params.rpcReceivedAt).toBe(1_000);
  expect(params.rpcCheckpoints.map(({ stage, at }) => [stage, at])).toEqual([
    ["gateway_routing", 1_010],
    ["gateway_storage", 1_030],
    ["gateway_content", 1_060],
    // The reset phase (5) and session preparation (40) both end before this one.
    ["gateway_session", 1_105],
    ["gateway_admission", 1_155],
    ["gateway_session_write", 1_215],
    ["gateway_delivery", 1_285],
    ["gateway_dispatch", 1_365],
  ]);
});
