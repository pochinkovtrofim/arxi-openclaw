// Covers suspension RPC validation and coordinator response mapping.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suspendHandlers } from "./suspend.js";

const coordinator = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
  resume: vi.fn(),
}));
const outbound = vi.hoisted(() => ({ inspect: vi.fn() }));
const agentDatabases = vi.hoisted(() => ({
  closeIdle: vi.fn(),
  closeIdleExecutions: vi.fn(),
  suspendMemory: vi.fn(),
}));
const runtimeConfig = vi.hoisted(() => ({ agents: {} }));

vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  prepareGatewaySuspend: coordinator.prepare,
  getGatewaySuspendStatus: coordinator.status,
  resumeGatewaySuspend: coordinator.resume,
}));

vi.mock("../../infra/delivery-queue-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/delivery-queue-sqlite.js")>();
  return { ...actual, inspectPendingDeliveryQueueDeferrals: outbound.inspect };
});

vi.mock("../../state/openclaw-agent-db-lifecycle.js", () => ({
  closeIdleOpenClawAgentDatabases: agentDatabases.closeIdle,
}));

vi.mock("../../state/openclaw-agent-execution.js", () => ({
  closeIdleOpenClawAgentDatabaseExecutions: agentDatabases.closeIdleExecutions,
}));

vi.mock("../../plugins/memory-runtime.js", () => ({
  suspendMemorySearchManagersCore: agentDatabases.suspendMemory,
}));

vi.mock("../server-active-work.js", () => ({
  createGatewayServerActiveWorkInspectors: vi.fn(() => ({ getChatRuns: vi.fn(() => 0) })),
}));

function invoke(method: keyof typeof suspendHandlers, params: unknown) {
  const respond = vi.fn();
  const pauseScheduling = vi.fn();
  const resumeScheduling = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const handler = expectDefined(suspendHandlers[method], "suspendHandlers[method] test invariant");
  return Promise.resolve(
    handler({
      params,
      respond,
      context: {
        cron: { pauseScheduling, resumeScheduling },
        logGateway: { warn, info },
        getRuntimeConfig: () => runtimeConfig,
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
      },
    } as unknown as Parameters<typeof handler>[0]),
  ).then(() => ({ respond, pauseScheduling, resumeScheduling, info }));
}

beforeEach(() => {
  vi.clearAllMocks();
  outbound.inspect.mockResolvedValue({ pendingCount: 0, futureDeferredCount: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway suspend handlers", () => {
  it("validates the closed prepare params shape", async () => {
    const { respond } = await invoke("gateway.suspend.prepare", {
      requestId: "request-1",
      extra: true,
    });

    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid gateway.suspend.prepare params",
    });
  });

  it("wires prepare to scheduler pause/resume and returns busy or ready", async () => {
    coordinator.prepare.mockReturnValueOnce({
      status: "busy",
      reason: "active-work",
      activeCount: 1,
      blockers: [{ kind: "queue", count: 1, message: "busy" }],
    });
    const { respond, pauseScheduling, resumeScheduling } = await invoke("gateway.suspend.prepare", {
      requestId: "request-1",
    });

    expect(coordinator.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        terminalPolicy: "preserve",
        pauseScheduling: expect.any(Function),
        resumeScheduling: expect.any(Function),
      }),
    );
    const options = coordinator.prepare.mock.calls[0]?.[0];
    options.pauseScheduling();
    options.resumeScheduling();
    expect(pauseScheduling).toHaveBeenCalledOnce();
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "busy", reason: "active-work" }),
    );
  });

  it("maps a competing prepared lease to retryable unavailable", async () => {
    coordinator.prepare.mockReturnValueOnce({ status: "conflict", expiresAtMs: Date.now() + 5000 });
    const { respond } = await invoke("gateway.suspend.prepare", { requestId: "request-2" });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
        retryable: true,
      }),
    );
  });

  it("holds an empty outbound rollback fence across an idempotent ordinary retry", async () => {
    const ready = {
      status: "ready",
      suspensionId: "suspension-empty-outbound",
      expiresAtMs: Date.now() + 60_000,
      activeCount: 0,
      blockers: [],
      wakeRequirement: { kind: "external-event-only" },
    };
    coordinator.prepare.mockReturnValue(ready);
    coordinator.status.mockReturnValue(ready);

    const fenced = await invoke("gateway.suspend.prepare", {
      requestId: "request-empty-outbound",
      requireEmptyOutbound: true,
    });
    const lifecycleRetry = await invoke("gateway.suspend.prepare", {
      requestId: "request-empty-outbound",
    });

    expect(fenced.respond).toHaveBeenCalledWith(true, ready);
    expect(lifecycleRetry.respond).toHaveBeenCalledWith(true, ready);
    expect(outbound.inspect).toHaveBeenCalledOnce();
    expect(coordinator.resume).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "pending outbound custody",
      arrange: () =>
        outbound.inspect.mockResolvedValue({ pendingCount: 1, futureDeferredCount: 0 }),
    },
    {
      name: "an ambiguous inventory read",
      arrange: () => outbound.inspect.mockRejectedValue(new Error("state worker unavailable")),
    },
  ])("releases the suspension after $name", async ({ arrange }) => {
    const ready = {
      status: "ready",
      suspensionId: "suspension-blocked-outbound",
      expiresAtMs: Date.now() + 60_000,
      activeCount: 0,
      blockers: [],
      wakeRequirement: { kind: "external-event-only" },
    };
    coordinator.prepare.mockReturnValue(ready);
    coordinator.status.mockReturnValue(ready);
    coordinator.resume.mockReturnValue({ ok: true, status: "running", resumed: true });
    arrange();

    const { respond } = await invoke("gateway.suspend.prepare", {
      requestId: "request-blocked-outbound",
      requireEmptyOutbound: true,
    });

    expect(coordinator.resume).toHaveBeenCalledWith(ready.suspensionId);
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "gateway suspension preflight is unavailable",
      retryable: true,
      retryAfterMs: 1_000,
      details: { reason: "gateway-suspension-preflight-failed" },
    });
  });

  it("passes an explicit preserve-only drain through without changing its wire result", async () => {
    const result = {
      status: "draining",
      suspensionId: "suspension-draining",
      expiresAtMs: 123_000,
      retryAfterMs: 20_000,
      activeCount: 1,
      blockers: [{ kind: "terminal-session", count: 1, message: "one preserved terminal" }],
    };
    coordinator.prepare.mockReturnValueOnce(result);

    const { respond, info } = await invoke("gateway.suspend.prepare", {
      requestId: "request-draining",
      drain: true,
    });

    expect(coordinator.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-draining",
        terminalPolicy: "preserve",
        drain: true,
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, result);
    expect(info).toHaveBeenCalledWith(
      'DRAINING activeCount=1 blockers=terminal-session:1 holders=["one preserved terminal"] custody=clear',
    );
  });

  it("returns a draining status without exposing its owner's suspension id", async () => {
    vi.useFakeTimers();
    const result = {
      status: "draining",
      expiresAtMs: 123_000,
      retryAfterMs: 20_000,
      activeCount: 2,
      blockers: [
        { kind: "root-request", count: 1, message: "1 active gateway request(s): http:openai" },
        {
          kind: "terminal-persistence",
          count: 1,
          message: "1 pending terminal session write(s): run=run-1 session=agent:main:chat-1",
        },
      ],
      writeCustody: [{ phase: "terminal-persistence", count: 1 }],
    };
    coordinator.status.mockReturnValue(result);

    const response = invoke("gateway.suspend.status", {
      suspensionId: "suspension-draining",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const { respond, info } = await response;

    expect(coordinator.status).toHaveBeenCalledWith("suspension-draining", false);
    expect(respond).toHaveBeenCalledWith(true, result);
    expect(info).toHaveBeenCalledWith(
      'DRAINING activeCount=2 blockers=root-request:1,terminal-persistence:1 holders=["1 active gateway request(s): http:openai","1 pending terminal session write(s): run=run-1 session=agent:main:chat-1"] custody=held',
    );
  });

  it("closes idle agent databases before confirming a ready suspension", async () => {
    const ready = { status: "ready", suspensionId: "suspension-ready", expiresAtMs: 123_000 };
    const order: string[] = [];
    coordinator.status.mockImplementation(() => {
      order.push("status");
      return ready;
    });
    agentDatabases.suspendMemory.mockImplementation(async () => {
      order.push("memory");
      return { resume: vi.fn(), errors: [] };
    });
    agentDatabases.closeIdleExecutions.mockImplementation(async () => {
      order.push("executions");
      return { closed: 1, busy: 0 };
    });
    agentDatabases.closeIdle.mockImplementation(() => {
      order.push("handles");
      return { closed: 1, borrowed: 1, transaction: 0, failed: 0 };
    });

    const { respond, info } = await invoke("gateway.suspend.status", {
      suspensionId: "suspension-ready",
    });

    expect(order).toEqual(["status", "status", "memory", "executions", "handles", "status"]);
    expect(respond).toHaveBeenCalledWith(true, ready);
    expect(info).toHaveBeenCalledWith(
      "idle agent databases closed before suspension: executions closed=1 busy=0; handles closed=1 borrowed=1 transaction=0 failed=0",
    );

    agentDatabases.suspendMemory.mockClear();
    agentDatabases.closeIdleExecutions.mockClear();
    coordinator.status.mockReturnValue({ status: "running" });
    await invoke("gateway.suspend.status", { suspensionId: "suspension-ready" });
    expect(agentDatabases.suspendMemory).not.toHaveBeenCalled();
    expect(agentDatabases.closeIdleExecutions).not.toHaveBeenCalled();
  });

  it("reopens memory closed for a ready suspension when the process resumes", async () => {
    coordinator.prepare.mockReturnValueOnce({ status: "busy", reason: "active-work" });
    await invoke("gateway.suspend.prepare", { requestId: "request-memory" });
    const options = coordinator.prepare.mock.calls[0]?.[0];
    // Drop a resume left by an earlier suspension in this module.
    options.resumeScheduling();
    await Promise.resolve();
    coordinator.status.mockReturnValue({ status: "ready", suspensionId: "s", expiresAtMs: 1 });
    agentDatabases.closeIdleExecutions.mockResolvedValue({ closed: 0, busy: 0 });
    agentDatabases.closeIdle.mockReturnValue({ closed: 0, borrowed: 0, transaction: 0, failed: 0 });
    const resumeMemory = vi.fn();
    let finishSuspend!: (suspension: { resume: typeof resumeMemory; errors: unknown[] }) => void;
    agentDatabases.suspendMemory.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSuspend = resolve;
      }),
    );
    agentDatabases.suspendMemory.mockResolvedValue({ resume: vi.fn(), errors: [] });

    vi.useFakeTimers();
    const status = invoke("gateway.suspend.status", { suspensionId: "s" });
    await vi.advanceTimersByTimeAsync(5_000);
    await status;
    // The ready answer did not wait for memory; a repeated status keeps the first resume.
    await invoke("gateway.suspend.status", { suspensionId: "s" });
    options.resumeScheduling();
    expect(resumeMemory).not.toHaveBeenCalled();

    finishSuspend({ resume: resumeMemory, errors: [] });
    await vi.waitFor(() => expect(resumeMemory).toHaveBeenCalledWith({ cfg: runtimeConfig }));
    options.resumeScheduling();
    expect(resumeMemory).toHaveBeenCalledOnce();
  });

  it("maps prepare and status recovery to the same retryable unavailable error", async () => {
    const recovering = {
      status: "recovering",
      reason: "scheduler-resume-failed",
      retryAfterMs: 1_000,
    };
    coordinator.prepare.mockReturnValueOnce(recovering);
    coordinator.status.mockReturnValue(recovering);

    const prepared = await invoke("gateway.suspend.prepare", { requestId: "request-recovery" });
    const status = await invoke("gateway.suspend.status", { suspensionId: "stale-id" });

    for (const respond of [prepared.respond, status.respond]) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "gateway scheduler recovery is pending",
          retryable: true,
          retryAfterMs: 1_000,
          details: { reason: "scheduler-resume-failed" },
        }),
      );
    }
  });

  it("keeps resume idempotent and rejects a mismatched active lease", async () => {
    coordinator.resume.mockReturnValueOnce({ ok: false, reason: "suspension-mismatch" });
    const mismatch = await invoke("gateway.suspend.resume", {
      suspensionId: "suspension-wrong",
    });
    expect(mismatch.respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "gateway suspension id does not match",
    });

    coordinator.resume.mockReturnValueOnce({
      ok: true,
      status: "running",
      resumed: false,
    });
    const resumed = await invoke("gateway.suspend.resume", { suspensionId: "suspension-1" });
    expect(resumed.respond).toHaveBeenCalledWith(true, {
      ok: true,
      status: "running",
      resumed: false,
    });
  });

  it("returns retryable unavailable when scheduler resume needs retry", async () => {
    coordinator.resume.mockReturnValueOnce({
      ok: false,
      reason: "scheduler-resume-failed",
      retryAfterMs: 1_000,
    });

    const { respond } = await invoke("gateway.suspend.resume", {
      suspensionId: "suspension-1",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "gateway scheduler recovery is pending",
        retryable: true,
        retryAfterMs: 1_000,
        details: { reason: "scheduler-resume-failed" },
      }),
    );
  });
});
