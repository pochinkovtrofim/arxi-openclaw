// Covers suspension RPC validation and coordinator response mapping.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { suspendHandlers } from "./suspend.js";

const coordinator = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
  resume: vi.fn(),
}));
const outbound = vi.hoisted(() => ({ inspect: vi.fn() }));

vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  prepareGatewaySuspend: coordinator.prepare,
  getGatewaySuspendStatus: coordinator.status,
  resumeGatewaySuspend: coordinator.resume,
}));

vi.mock("../../infra/delivery-queue-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/delivery-queue-sqlite.js")>();
  return { ...actual, inspectPendingDeliveryQueueDeferrals: outbound.inspect };
});

vi.mock("../server-active-work.js", () => ({
  createGatewayServerActiveWorkInspectors: vi.fn(() => ({ getChatRuns: vi.fn(() => 0) })),
}));

function invoke(method: keyof typeof suspendHandlers, params: unknown) {
  const respond = vi.fn();
  const pauseScheduling = vi.fn();
  const resumeScheduling = vi.fn();
  const warn = vi.fn();
  const handler = expectDefined(suspendHandlers[method], "suspendHandlers[method] test invariant");
  return Promise.resolve(
    handler({
      params,
      respond,
      context: {
        cron: { pauseScheduling, resumeScheduling },
        logGateway: { warn },
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
      },
    } as unknown as Parameters<typeof handler>[0]),
  ).then(() => ({ respond, pauseScheduling, resumeScheduling }));
}

beforeEach(() => {
  vi.clearAllMocks();
  outbound.inspect.mockResolvedValue({ pendingCount: 0, futureDeferredCount: 0 });
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

    const { respond } = await invoke("gateway.suspend.prepare", {
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
  });

  it("returns a draining status without exposing its owner's suspension id", async () => {
    const result = {
      status: "draining",
      expiresAtMs: 123_000,
      retryAfterMs: 20_000,
      activeCount: 1,
      blockers: [{ kind: "reply", count: 1, message: "one pending reply" }],
    };
    coordinator.status.mockReturnValueOnce(result);

    const { respond } = await invoke("gateway.suspend.status", {
      suspensionId: "suspension-draining",
    });

    expect(coordinator.status).toHaveBeenCalledWith("suspension-draining");
    expect(respond).toHaveBeenCalledWith(true, result);
  });

  it("maps prepare and status recovery to the same retryable unavailable error", async () => {
    const recovering = {
      status: "recovering",
      reason: "scheduler-resume-failed",
      retryAfterMs: 1_000,
    };
    coordinator.prepare.mockReturnValueOnce(recovering);
    coordinator.status.mockReturnValueOnce(recovering);

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
