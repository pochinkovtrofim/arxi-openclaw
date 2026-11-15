import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import type { AgentCommandGatewayIngressOpts } from "./command/types.js";

const mocks = vi.hoisted(() => ({
  emitTrustedDiagnosticEvent: vi.fn(),
  clock: { tick: (_ms: number) => {} },
}));

vi.mock("../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/diagnostic-events.js")>()),
  emitTrustedDiagnosticEvent: mocks.emitTrustedDiagnosticEvent,
}));
// mock-isolation: only the preflight timeline is under test, not preparation or the run.
vi.mock("./command/prepare.js", () => ({
  prepareAgentCommandExecution: async (
    _opts: unknown,
    _runtime: unknown,
    _context: unknown,
    onPhase?: (step: string) => void,
  ) => {
    mocks.clock.tick(100);
    onPhase?.("runtime_config");
    mocks.clock.tick(30);
    onPhase?.("session_resolve");
    mocks.clock.tick(20);
    return { agentDir: "/agent" };
  },
}));
vi.mock("./agent-command-recovery-owner.js", () => ({
  runWithAgentCommandRecoveryOwner: async (params: {
    opts: unknown;
    prepare: (opts: unknown) => Promise<unknown>;
  }) => {
    await params.prepare(params.opts);
    return undefined;
  },
}));

import { agentCommandFromGatewayIngress } from "./agent-command.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 10_000, toFake: ["Date"] });
  mocks.clock.tick = (ms) => vi.advanceTimersByTime(ms);
  mocks.emitTrustedDiagnosticEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function run(opts: Partial<AgentCommandGatewayIngressOpts>) {
  return runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
    agentCommandFromGatewayIngress(
      {
        message: "hi",
        sessionKey: "agent:main:main",
        allowModelOverride: false,
        ...opts,
      } as AgentCommandGatewayIngressOpts,
      {} as never,
      undefined,
      {},
    ),
  );
}

function stages() {
  return mocks.emitTrustedDiagnosticEvent.mock.calls
    .map(([event]) => event)
    .map((event) => [event.stage, event.startedAt, event.durationMs]);
}

it("emits command_prepare.* inside the command_prepare window, after it", async () => {
  await run({});
  expect(stages()).toEqual([
    ["command_prepare", 10_000, 150],
    ["command_prepare.runtime_config", 10_000, 100],
    ["command_prepare.session_resolve", 10_100, 30],
  ]);
  const spans = mocks.emitTrustedDiagnosticEvent.mock.calls.map(([event]) => event.trace.spanId);
  expect(new Set(spans).size).toBe(3);
});

it("replays the Gateway's step moments as sub-stages of the stage they sit in", async () => {
  await run({
    rpcReceivedAt: 9_000,
    rpcCheckpoints: [
      { stage: "gateway_preflight", at: 9_100 },
      {
        stage: "gateway_session_write",
        at: 9_600,
        steps: [
          { step: "skill_library_selection", at: 9_250 },
          { step: "session_store_commit", at: 9_550 },
          { step: "session_created_record", at: 9_700 }, // after the window
        ],
      },
    ],
  });
  expect(stages().slice(0, 5)).toEqual([
    ["gateway_preflight", 9_000, 100],
    ["gateway_session_write", 9_100, 500],
    ["gateway_session_write.skill_library_selection", 9_100, 150],
    ["gateway_session_write.session_store_commit", 9_250, 300],
    ["gateway_rpc", 9_600, 400],
  ]);
});
