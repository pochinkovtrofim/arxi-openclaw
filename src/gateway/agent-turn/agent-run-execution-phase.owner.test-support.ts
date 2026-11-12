import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { startAgentRunExecution } from "./agent-run-execution-phase.js";

export function createExecution(
  options: {
    aborted?: boolean;
    admissionTrace?: DiagnosticTraceContext;
    diagnosticTrace?: DiagnosticTraceContext;
    assertContextCurrent?: () => void;
    admittedConversationId?: string;
    admittedRequesterSenderId?: string;
    admittedMessageId?: string;
    admittedReplyOptional?: boolean;
    deliveryChatType?: "direct" | "group" | "channel";
    deliver?: boolean;
    groupId?: string;
    operatorAdminClient?: "local" | "remote";
    senderIsOwner?: boolean;
    pendingInputSettlement?: () => Promise<void>;
  } = {},
) {
  const abortCleanup = vi.fn();
  const gatewayRelease = vi.fn();
  const callerRelease = vi.fn();
  const { promise: runtimeReleased, resolve: resolveRuntimeReleased } = createDeferred();
  const runtimeRelease = vi.fn(async () => resolveRuntimeReleased());
  const controller = new AbortController();
  if (options.aborted) {
    controller.abort();
  }
  return {
    abortCleanup,
    gatewayRelease,
    callerRelease,
    runtimeRelease,
    runtimeReleased,
    params: {
      assertContextCurrent: options.assertContextCurrent,
      prepared: {
        releaseCallerAuthority: callerRelease,
        activeGatewayWorkAdmission: {
          release: gatewayRelease,
          run: async (run: () => Promise<void>) =>
            options.admissionTrace
              ? await runWithDiagnosticTraceContext(options.admissionTrace, run)
              : await run(),
        },
        activeRunAbort: {
          cleanup: abortCleanup,
          controller,
          registered: false,
        },
        effectiveAllowModelOverride: false,
        lifecycleStorePath: "",
        operationalRunInstance: {},
        preparedModelRuntimeLease: { [Symbol.asyncDispose]: runtimeRelease, snapshot: {} },
        replyDispatchRuntime: {
          config: { runtime: "A" },
          pluginGeneration: "generation-A",
        },
        unpersistedOffloadedRefs: [],
        userTurn: {
          recorder: options.pendingInputSettlement
            ? { waitForPendingInputSettlement: options.pendingInputSettlement }
            : undefined,
          execApprovalFollowupHandoffClaimId: "claim",
          message: "continue",
          senderIsOwner: options.senderIsOwner ?? false,
          suppressPromptPersistence: false,
        },
        workspaceOverride: "/workspace/A",
      },
      request: {
        admittedConversationId: options.admittedConversationId,
        admittedRequesterSenderId: options.admittedRequesterSenderId,
        admittedMessageId: options.admittedMessageId,
        admittedReplyOptional: options.admittedReplyOptional,
      },
      cfg: {},
      activeSessionAgentId: "main",
      delivery: {
        deliver: options.deliver ?? false,
        resolvedChatType: options.deliveryChatType,
      },
      isNewSession: false,
      isRawModelRun: true,
      isOneShotModelRun: true,
      isRestartRecoveryResumeRun: false,
      suppressVisibleSessionEffects: true,
      images: [],
      imageOrder: [],
      media: [],
      groupId: options.groupId,
      runId: "owner-test",
      agentDedupeKeys: [],
      bestEffortDeliver: false,
      lifecycleGeneration: "test",
      preserveUserFacingSessionModelState: false,
      skipAgentInitialSessionTouch: true,
      canUseInternalRuntimeHandoff: false,
      diagnosticTrace: options.diagnosticTrace,
      client:
        options.operatorAdminClient === "local"
          ? {
              internal: { isLocalClient: true },
              connect: { scopes: ["operator.admin"] },
            }
          : options.operatorAdminClient === "remote"
            ? { connect: { scopes: ["operator.admin"] } }
            : null,
      context: {
        getSessionEventSubscriberConnIds: () => new Set(),
        dedupe: new Map(),
        chatAbortControllers: new Map(),
        deps: {},
        logGateway: { error: vi.fn(), warn: vi.fn() },
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: vi.fn(),
      },
      releaseCronContinuationClaimWithRecovery: async () => true,
    } as unknown as Parameters<typeof startAgentRunExecution>[0],
  };
}

export function createVisibleExecution() {
  const execution = createExecution();
  const sessionKey = "agent:main:task-access-liveness";
  Object.assign(execution.params, {
    suppressVisibleSessionEffects: false,
    requestedSessionKey: sessionKey,
    resolvedSessionKey: sessionKey,
  });
  Object.assign(execution.params.context, {
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  execution.params.prepared.activeRunAbort.markExecutionStarted = vi.fn(() => true);
  execution.params.prepared.userTurn.recorder = {
    finishPendingInput: vi.fn(),
  } as unknown as NonNullable<typeof execution.params.prepared.userTurn.recorder>;
  return execution;
}

export function bindFollowupCompletion(execution: ReturnType<typeof createExecution>) {
  const { params } = execution;
  const sessionKey = "agent:main:followup-owner";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const entry: ChatAbortControllerEntry = {
    controller: params.prepared.activeRunAbort.controller,
    sessionId: "followup-session",
    sessionKey,
    operationalRunInstance: params.prepared.operationalRunInstance,
    lifecycleGeneration,
    startedAtMs: 1,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  params.resolvedSessionKey = sessionKey;
  params.resolvedSessionId = entry.sessionId;
  params.lifecycleGeneration = lifecycleGeneration;
  params.context.chatAbortControllers = new Map([[params.runId, entry]]);
  params.prepared.activeRunAbort = {
    ...params.prepared.activeRunAbort,
    registered: true,
    entry,
  };
  params.prepared.activeGatewayWorkAdmission.isActive = () => true;
  execution.abortCleanup.mockImplementation(() => {
    if (params.context.chatAbortControllers.get(params.runId) === entry) {
      params.context.chatAbortControllers.delete(params.runId);
    }
  });
  const custody = new AbortController();
  const owner = SessionFollowupCompletion.bind({
    runId: params.runId,
    requesterSessionKey: "agent:main:requester",
    requesterSessionId: "requester-session",
    requesterAgentId: "main",
    targetAgentId: "main",
    targetSessionKey: sessionKey,
    custody: {
      signal: custody.signal,
      assertCurrent: () => custody.signal.throwIfAborted(),
      run: (work) => work(),
      release: () => custody.abort(),
    },
  });
  owner.markAccepted(params.runId);
  params.prepared.followupCompletion = owner;
  return owner;
}
