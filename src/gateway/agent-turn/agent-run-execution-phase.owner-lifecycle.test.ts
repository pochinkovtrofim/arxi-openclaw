import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getActiveDiagnosticTraceContext, type DiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { replayAgentTurnIfCached } from "./agent-dedupe.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import { bindFollowupCompletion, createExecution, createVisibleExecution } from "./agent-run-execution-phase.owner.test-support.js";

const { dispatchAgentRunFromGateway, agentCommand } = vi.hoisted(() => ({
  dispatchAgentRunFromGateway: vi.fn(),
  agentCommand: vi.fn(),
}));
const logMessageDispatchStarted = vi.hoisted(() => vi.fn());
const logMessageProcessed = vi.hoisted(() => vi.fn());

vi.mock("../../commands/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/agent.js")>()),
  agentCommandFromGatewayIngress: agentCommand,
}));

vi.mock("./agent-run-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-run-dispatch.js")>()),
  dispatchAgentRunFromGateway,
}));

vi.mock("../../logging/diagnostic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/diagnostic.js")>()),
  logMessageDispatchStarted,
  logMessageProcessed,
}));

describe("startAgentRunExecution Gateway ownership", () => {
  beforeEach(() => {
    dispatchAgentRunFromGateway.mockReset();
    logMessageDispatchStarted.mockReset();
    logMessageProcessed.mockReset();
    agentCommand.mockReset();
  });

  it("keeps the gateway message lifecycle open until the agent run settles", async () => {
    const ingressTrace: DiagnosticTraceContext = {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: "01",
    };
    const execution = createExecution({ diagnosticTrace: ingressTrace });
    let resolveDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      resolveDispatched = resolve;
    });
    let dispatchStartedTrace: DiagnosticTraceContext | undefined;
    let processedTrace: DiagnosticTraceContext | undefined;
    logMessageDispatchStarted.mockImplementationOnce(() => {
      dispatchStartedTrace = getActiveDiagnosticTraceContext();
    });
    logMessageProcessed.mockImplementationOnce(() => {
      processedTrace = getActiveDiagnosticTraceContext();
    });
    dispatchAgentRunFromGateway.mockImplementationOnce(resolveDispatched);

    void startAgentRunExecution(execution.params);

    await dispatched;
    expect(logMessageDispatchStarted).toHaveBeenCalledOnce();
    expect(logMessageProcessed).not.toHaveBeenCalled();
    const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
    await dispatch?.onSettled?.({
      terminalOutcome: { reason: "completed", status: "ok" },
    });
    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", reason: "completed" }),
    );
    expect(processedTrace).toEqual(dispatchStartedTrace);
  });

  it("closes the gateway message lifecycle when dispatch throws", async () => {
    const execution = createExecution({
      diagnosticTrace: {
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        traceFlags: "01",
      },
    });
    dispatchAgentRunFromGateway.mockImplementationOnce(() => {
      throw new Error("dispatch unavailable");
    });

    void startAgentRunExecution(execution.params);

    await execution.runtimeReleased;
    expect(logMessageDispatchStarted).toHaveBeenCalledOnce();
    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        reason: "dispatch_failed",
        error: "dispatch unavailable",
      }),
    );
  });
  it.each([undefined, "/workspace/session-override"])(
    "preserves the admitted workspace with session override %s",
    async (workspaceOverride) => {
      const execution = createExecution();
      execution.params.prepared.workspaceOverride = workspaceOverride;
      execution.params.prepared.replyDispatchRuntime = {
        ...execution.params.prepared.replyDispatchRuntime,
        workspaceDir: "/workspace/admitted",
      };
      dispatchAgentRunFromGateway.mockResolvedValueOnce(undefined);

      await startAgentRunExecution(execution.params);

      const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
      expect(dispatch?.ingressOpts.workspaceDir).toBe(workspaceOverride ?? "/workspace/admitted");
      expect(execution.runtimeRelease).toHaveBeenCalledOnce();
      expect(execution.callerRelease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { ending: "aborted", registration: "current" },
    { ending: "failed", registration: "current" },
    { ending: "aborted", registration: "foreign" },
    { ending: "aborted", registration: "absent" },
    { ending: "aborted", registration: "replacement" },
    { ending: "aborted", registration: "controller" },
    { ending: "aborted", registration: "session" },
    { ending: "aborted", registration: "instance" },
    { ending: "aborted", registration: "lifecycle" },
  ] as const)(
    "settles an undispatched $ending followup only after cleanup (registration: $registration)",
    async ({ ending, registration }) => {
      const settlementEntered = createDeferred();
      const finishSettlement = createDeferred();
      const execution = createExecution({
        pendingInputSettlement: async () => {
          settlementEntered.resolve();
          await finishSettlement.promise;
        },
        aborted: ending === "aborted",
        ...(ending === "failed"
          ? {
              assertContextCurrent: () => {
                throw new Error("Gateway owner retired");
              },
            }
          : {}),
      });
      execution.params.agentDedupeKeys = [`agent:${execution.params.runId}`];
      const owner = bindFollowupCompletion(execution);
      const entry = execution.params.prepared.activeRunAbort.entry!;
      const successor =
        registration === "foreign" || registration === "replacement"
          ? {
              ...entry,
              controller: new AbortController(),
              sessionKey: registration === "foreign" ? "agent:main:unrelated" : entry.sessionKey,
              operationalRunInstance: { runId: execution.params.runId, instanceId: "successor" },
            }
          : undefined;
      if (successor) {
        execution.params.context.chatAbortControllers.set(execution.params.runId, successor);
      }
      const lostRegistration = !["current", "foreign", "absent"].includes(registration);
      execution.params.prepared.activeGatewayWorkAdmission.run = async (run) => {
        if (registration === "absent") {
          execution.params.context.chatAbortControllers.delete(execution.params.runId);
        } else if (registration === "controller") {
          entry.controller = new AbortController();
        } else if (registration === "session") {
          entry.sessionKey = "agent:main:unrelated";
        } else if (registration === "instance") {
          entry.operationalRunInstance = { runId: execution.params.runId, instanceId: "successor" };
        } else if (registration === "lifecycle") {
          entry.lifecycleGeneration = "successor-lifecycle";
        }
        return await run();
      };
      const recoveryEntered = createDeferred();
      const releaseRecovery = createDeferred();
      const disposalEntered = createDeferred();
      const finishDisposal = createDeferred();
      execution.params.releaseCronContinuationClaimWithRecovery = async () => {
        recoveryEntered.resolve();
        await releaseRecovery.promise;
        return true;
      };
      execution.runtimeRelease.mockImplementation(async () => {
        disposalEntered.resolve();
        await finishDisposal.promise;
      });
      const finishExecution = vi.spyOn(owner, "finishExecution");
      const replyObserved = vi.fn();
      const reply = owner.take().then((result) => {
        replyObserved(result);
        return result;
      });
      void reply.catch(() => {});
      const finished = vi.fn();
      const completion = startAgentRunExecution(execution.params).then(finished);
      try {
        await Promise.race([recoveryEntered.promise, completion]);
        expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
        expect(execution.params.io.emitFinal).not.toHaveBeenCalled();
        expect(execution.params.context.dedupe.size).toBe(0);
        expect(finishExecution).not.toHaveBeenCalled();
        expect(replyObserved).not.toHaveBeenCalled();
        expect(execution.abortCleanup).not.toHaveBeenCalled();
        releaseRecovery.resolve();
        await Promise.race([settlementEntered.promise, completion]);
        expect(execution.params.io.emitFinal).not.toHaveBeenCalled();
        expect(execution.params.context.dedupe.size).toBe(0);
        expect(execution.abortCleanup).not.toHaveBeenCalled();
        finishSettlement.resolve();
        await Promise.race([disposalEntered.promise, completion]);
        expect(execution.params.io.emitFinal).toHaveBeenCalledOnce();
        expect(execution.params.context.dedupe.size).toBe(1);
        expect(execution.abortCleanup).toHaveBeenCalledOnce();
        expect(execution.gatewayRelease).toHaveBeenCalledOnce();
        expect(execution.runtimeRelease).toHaveBeenCalledOnce();
        expect(execution.callerRelease).not.toHaveBeenCalled();
        expect(finishExecution).not.toHaveBeenCalled();
        expect(replyObserved).not.toHaveBeenCalled();
        expect(finished).not.toHaveBeenCalled();
        finishDisposal.resolve();
        await completion;
        expect(finished).toHaveBeenCalledOnce();
        expect(execution.callerRelease).toHaveBeenCalledOnce();
        expect(finishExecution).toHaveBeenCalledExactlyOnceWith(execution.params.runId);
        if (successor) {
          expect(execution.params.context.chatAbortControllers.get(execution.params.runId)).toBe(
            successor,
          );
        }
        if (lostRegistration) {
          await expect(reply).rejects.toThrow("Follow-up admission was replaced before cleanup.");
        } else {
          await expect(reply).resolves.toMatchObject(
            ending === "aborted"
              ? { status: "error", stopReason: "rpc" }
              : { status: "error", error: "Gateway owner retired" },
          );
        }
      } finally {
        releaseRecovery.resolve();
        finishSettlement.resolve();
        finishDisposal.resolve();
        await completion.catch(() => {});
        owner.close();
      }
    },
  );

  it.each([false, true])(
    "releases the admitted runtime and preserves private failure replay before dispatch (Incognito: %s)",
    async (incognito) => {
      const privateMessage = "synthetic-private-pre-dispatch-error";
      const execution = createVisibleExecution();
      const fail = () => {
        throw new Error(privateMessage);
      };
      execution.params.assertContextCurrent = fail;
      execution.params.prepared.userTurn.releaseProcessingAbortObserver = fail;
      Object.assign(execution.params.prepared.userTurn.recorder ?? {}, {
        completeProcessing: fail,
      });
      execution.params.resolvedSessionKey = "agent:main:dashboard:private-owner";
      execution.params.sessionEntry = {
        sessionId: "private-owner",
        updatedAt: Date.now(),
        ...(incognito ? { incognito: true } : {}),
      };
      execution.params.agentDedupeKeys = [`agent:${execution.params.runId}`];

      await startAgentRunExecution(execution.params);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
      expect(execution.abortCleanup).toHaveBeenCalledOnce();
      expect(execution.gatewayRelease).toHaveBeenCalledOnce();
      expect(execution.runtimeRelease).toHaveBeenCalledOnce();
      const warnings = vi.mocked(execution.params.context.logGateway.warn).mock.calls;
      expect(warnings).toHaveLength(2);
      if (incognito) {
        expect.soft(JSON.stringify(warnings)).not.toContain(privateMessage);
      } else {
        expect(JSON.stringify(warnings)).toContain(privateMessage);
      }
      const [frame, metadata] = vi.mocked(execution.params.io.emitFinal).mock.calls[0] ?? [];
      expect(frame?.[2]?.message).toBe(privateMessage);
      const diagnostics = { errorMessage: frame?.[2]?.message, ...metadata };
      if (incognito) {
        expect.soft(JSON.stringify(diagnostics)).not.toContain(privateMessage);
      } else {
        expect(diagnostics).toMatchObject({ error: privateMessage, errorMessage: privateMessage });
      }

      const emitAcceptance = vi.fn();
      expect(
        replayAgentTurnIfCached({
          preflight: {
            runId: execution.params.runId,
            agentDedupeKeys: execution.params.agentDedupeKeys,
          },
          context: execution.params.context,
          io: { emitAcceptance, emitFinal: vi.fn() },
        }),
      ).toBe(true);
      const [replayFrame, replayMetadata] = emitAcceptance.mock.calls[0] ?? [];
      expect(replayFrame).toEqual(frame);
      const replayDiagnostics = { errorMessage: replayFrame?.[2]?.message, ...replayMetadata };
      if (incognito) {
        expect(JSON.stringify(replayDiagnostics)).not.toContain(privateMessage);
      } else {
        expect(replayDiagnostics).toMatchObject({ cached: true, errorMessage: privateMessage });
      }
    },
  );
});
