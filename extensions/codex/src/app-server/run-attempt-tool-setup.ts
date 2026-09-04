import {
  embeddedAgentLog,
  isHostScopedAgentToolActive,
  materializeRequesterScopedMcpToolsForHarnessRun,
  resolveAgentDir,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  captureFinalCodexCronCreatorToolAllowlist,
  hasExplicitFiniteCodexToolAllowlist,
  materializeStaticMcpToolsForScheduledHarnessRun,
  resolveScheduledCodexMcpIdentityBindings,
  shouldWithholdStaticCodexMcp,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { resolveCodexPluginsPolicy, shouldAutoApproveCodexAppServerApprovals } from "./config.js";
import {
  buildDynamicTools,
  formatCodexDynamicToolBuildStageSummary,
  resolveCodexMessageToolProvider,
  shouldWarnCodexDynamicToolBuildStageSummary,
} from "./dynamic-tool-build.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoadingForRuntime,
} from "./dynamic-tool-profile.js";
import {
  createCodexDynamicToolBridge,
  projectCodexExecutableDynamicTools,
} from "./dynamic-tools.js";
import { CodexCompactionPlanState } from "./plan-compaction-state.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import {
  captureScheduledCodexAppAuthority,
  resolveScheduledCodexAppCreatorCaptureDecision,
} from "./scheduled-app-authority.js";
import { formatScheduledMcpIdentityMismatch } from "./scheduled-mcp-identity.js";

function isAuthorityResolutionOperationAbort(error: unknown, signal: AbortSignal | undefined) {
  return signal?.aborted === true && error === signal.reason;
}

export async function prepareCodexAttemptTools(runtime: CodexAttemptRuntime) {
  const {
    connection,
    bundleMcpThreadConfig,
    bundleManifestRegistry,
    runtimeParams,
    effectiveRuntimeModelId,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    hookChannelId,
    codexMcpToolOverrides,
    authenticatedScheduledMode,
    ownsScheduledConfiguredMcpSurface,
    canResolveScheduledConfiguredMcpCreatorAuthority,
  } = runtime;
  const {
    params,
    preDynamicStartupStages,
    mutable,
    startupAuthProfileId,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    contextSessionKey,
    sandbox,
    sessionPermissionPolicy,
    runAbortController,
    sessionAgentId,
    policyAgentId,
    pluginConfig,
    profilerEnabled,
    agentDir,
  } = connection;
  const preDynamicSummary = preDynamicStartupStages.snapshot();
  if (shouldWarnCodexDynamicToolBuildStageSummary(preDynamicSummary)) {
    embeddedAgentLog.warn(
      `codex app-server pre-dynamic startup timings runId=${params.runId} sessionId=${params.sessionId} totalMs=${preDynamicSummary.totalMs} stages=${formatCodexDynamicToolBuildStageSummary(preDynamicSummary)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        totalMs: preDynamicSummary.totalMs,
        stages: preDynamicSummary.stages,
        hasStartupBinding: Boolean(mutable.startupBinding?.threadId),
        startupAuthProfileId: startupAuthProfileId ?? null,
        bundleMcpDiagnosticCount: bundleMcpThreadConfig.diagnostics.length,
        nativeToolSurfaceEnabled,
      },
    );
  }
  const toolState: {
    yieldDetected: boolean;
    yieldAcknowledgment?: string;
    persistentWebSearchAllowed?: boolean;
    webSearchAllowed: boolean;
  } = {
    yieldDetected: false,
    yieldAcknowledgment: undefined,
    persistentWebSearchAllowed: undefined as boolean | undefined,
    webSearchAllowed: false,
  };
  const toolOutcomeOrdinals = new Map<string, number>();
  const suppressedDynamicToolOutcomeOrdinals = new Set<number>();
  const onCodexToolOutcome = params.onToolOutcome
    ? (observation: Parameters<NonNullable<typeof params.onToolOutcome>>[0]) => {
        if (
          observation.toolCallOrdinal !== undefined &&
          suppressedDynamicToolOutcomeOrdinals.has(observation.toolCallOrdinal)
        ) {
          return;
        }
        params.onToolOutcome?.(observation);
      }
    : undefined;
  const baseAllocateToolOutcomeOrdinal = params.allocateToolOutcomeOrdinal;
  const allocateCodexToolOutcomeOrdinal = baseAllocateToolOutcomeOrdinal
    ? (toolCallId?: string): number => {
        const reservedOrdinal = toolCallId ? toolOutcomeOrdinals.get(toolCallId) : undefined;
        if (reservedOrdinal !== undefined) {
          return reservedOrdinal;
        }
        const ordinal = baseAllocateToolOutcomeOrdinal(toolCallId);
        if (toolCallId) {
          toolOutcomeOrdinals.set(toolCallId, ordinal);
        }
        return ordinal;
      }
    : undefined;
  const compactionPlanState = new CodexCompactionPlanState();
  const dynamicToolParams = {
    ...runtimeParams,
    onAgentEvent: (event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0]) => {
      compactionPlanState.record(event);
      return runtimeParams.onAgentEvent?.(event);
    },
    ...(allocateCodexToolOutcomeOrdinal
      ? { allocateToolOutcomeOrdinal: allocateCodexToolOutcomeOrdinal }
      : {}),
    ...(onCodexToolOutcome ? { onToolOutcome: onCodexToolOutcome } : {}),
  };
  const computerContextEpoch: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  } = { value: 0 };
  const runCleanups: Array<(reason: string) => Promise<void>> = [];
  const cronCreatorToolAllowlist: Array<string | { name: string; pluginId?: string }> = [];
  const cronCreatorToolAllowlistCaptureRef: {
    value?: { version: 1; source: "final-executable-surface" };
  } = {};
  const scheduledAppAuthoritySourceRef: {
    current?: Omit<
      Parameters<typeof captureScheduledCodexAppAuthority>[0],
      "profileId" | "accountId"
    >;
  } = {};
  const preparedChatgptAuth =
    connection.startupPreparedAuth?.kind === "profile" &&
    connection.startupPreparedAuth.snapshot?.loginParams.type === "chatgptAuthTokens" &&
    connection.startupPreparedAuth.snapshot.chatgptAccountId
      ? {
          profileId: connection.startupPreparedAuth.profileId,
          accountId: connection.startupPreparedAuth.snapshot.chatgptAccountId,
        }
      : undefined;
  const appPolicy = resolveCodexPluginsPolicy(pluginConfig);
  const codexAppsMayBeVisible =
    appPolicy.enabled &&
    (appPolicy.allowAllPlugins || appPolicy.pluginPolicies.some((entry) => entry.enabled));
  const appCreatorCapture = resolveScheduledCodexAppCreatorCaptureDecision({
    appsMayBeVisible: codexAppsMayBeVisible,
    authenticatedScheduledMode,
    usesSupervisionConnection: connection.usesSupervisionConnection,
    homeScope: connection.appServer.start.homeScope,
    hasPreparedAccountIdentity: Boolean(preparedChatgptAuth),
  });
  const codexAppAuthorityUnavailableReason = appCreatorCapture.unavailableReason;
  const canResolveScheduledCodexAppAuthority = appCreatorCapture.supported;
  const requiresScheduledCodexAppAuthority = appCreatorCapture.required;
  const canResolveAnyScheduledCreatorAuthority =
    canResolveScheduledConfiguredMcpCreatorAuthority || requiresScheduledCodexAppAuthority;
  let toolBridge: ReturnType<typeof createCodexDynamicToolBridge> | undefined;
  let creatorAuthorityPromise:
    | Promise<{
        tools: readonly (string | { name: string; pluginId?: string })[];
        provenance: { version: 1; source: "final-executable-surface" };
        runtimeAuthority?: NonNullable<EmbeddedRunAttemptParams["scheduledRuntimeAuthority"]>;
      }>
    | undefined;
  let resolveCreatorAuthorityImpl:
    | ((options?: { signal?: AbortSignal }) => Promise<{
        tools: readonly (string | { name: string; pluginId?: string })[];
        provenance: { version: 1; source: "final-executable-surface" };
        runtimeAuthority?: NonNullable<EmbeddedRunAttemptParams["scheduledRuntimeAuthority"]>;
      }>)
    | undefined;
  const runtimeYieldCompletionClaim: { current?: () => boolean } = {};
  const commonToolParams = {
    params: dynamicToolParams,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    sessionPermissionPolicy,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    runAbortController,
    sessionAgentId,
    policyAgentId,
    pluginConfig,
    profilerEnabled,
    ...(params.cronCreatorAuthorityUnavailableReason === "queued-local-operator" &&
    bundleMcpThreadConfig.staticServerNames.length > 0
      ? {
          cronCreatorAuthorityUnavailableReason: "queued-local-operator-configured-mcp" as const,
        }
      : {}),
    onYieldDetected: (acknowledgment: string | undefined) => {
      toolState.yieldDetected = true;
      toolState.yieldAcknowledgment = acknowledgment;
    },
    claimYieldCompletion: () => runtimeYieldCompletionClaim.current?.() ?? false,
    onCodexAppServerEvent: (event: Parameters<typeof emitCodexAppServerEvent>[1]) => {
      void emitCodexAppServerEvent(params, event);
    },
    computerContextEpoch,
    ...(canResolveAnyScheduledCreatorAuthority
      ? {
          resolveCronCreatorToolAuthority: (options?: { signal?: AbortSignal }) => {
            if (!resolveCreatorAuthorityImpl) {
              throw new Error("configured MCP authority resolver was invoked before tool setup");
            }
            options?.signal?.throwIfAborted();
            if (creatorAuthorityPromise) {
              return creatorAuthorityPromise;
            }
            const pending = resolveCreatorAuthorityImpl(options);
            creatorAuthorityPromise = pending;
            void pending.catch((error: unknown) => {
              // A tool-call timeout does not poison later cron mutations in the
              // same live turn. Substantive discovery/auth/policy failures stay cached.
              if (
                creatorAuthorityPromise === pending &&
                isAuthorityResolutionOperationAbort(error, options?.signal)
              ) {
                creatorAuthorityPromise = undefined;
              }
            });
            return pending;
          },
        }
      : {}),
  };
  const tools = await buildDynamicTools({
    ...commonToolParams,
    registerRunCleanup: (cleanup) => runCleanups.push(cleanup),
    cronCreatorToolAllowlistRef: cronCreatorToolAllowlist,
    cronCreatorToolAllowlistCaptureRef,
    onPersistentWebSearchPolicyResolved: (allowed) => {
      toolState.persistentWebSearchAllowed = allowed;
    },
    onWebSearchPolicyResolved: (allowed) => {
      toolState.webSearchAllowed = allowed;
    },
  });
  const registeredTools = await buildDynamicTools({
    ...commonToolParams,
    forceHeartbeatTool: true,
    ignoreDisableMessageTool: true,
    ignoreRuntimePlan: true,
  });
  const policyContext = {
    config: params.config,
    sessionKey: sandboxSessionKey,
    runSessionKey:
      params.sessionKey && params.sessionKey !== sandboxSessionKey ? params.sessionKey : undefined,
    sessionId: params.sessionId,
    runId: params.runId,
    agentId: policyAgentId,
    agentDir: agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId),
    agentAccountId: params.agentAccountId,
    messageProvider: params.messageProvider ?? params.messageChannel,
    messageChannel: params.messageChannel,
    chatType: params.chatType,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    currentChannelId: params.currentChannelId,
    currentMessagingTarget: params.currentMessagingTarget,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    memberRoleIds: params.memberRoleIds,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    modelProvider: params.provider,
    modelId: params.modelId,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    modelHasVision: params.model.input?.includes("image") ?? false,
    workspaceDir: effectiveWorkspace,
    cwd: effectiveCwd ?? effectiveWorkspace,
    sandboxToolPolicy: sandbox?.tools,
    conversationToolPolicy: params.conversationToolPolicy,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    scheduledToolPolicy: params.scheduledToolPolicy,
  };
  const reservedToolNames = [
    ...tools.map((tool) => tool.name),
    ...registeredTools.map((tool) => tool.name),
  ];
  const turnSourceChannel = params.messageChannel ?? params.messageProvider;
  const turnSourceTo = params.currentMessagingTarget ?? params.currentChannelId;
  const requester = {
    ...(turnSourceChannel ? { channel: turnSourceChannel } : {}),
    ...(params.agentAccountId ? { accountId: params.agentAccountId } : {}),
    ...(params.senderId ? { senderId: params.senderId } : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.memberRoleIds?.length ? { roleIds: [...params.memberRoleIds] } : {}),
  };
  const hasRequester = Object.keys(requester).length > 0;
  const autoApproveScheduledMcp = shouldAutoApproveCodexAppServerApprovals(connection.appServer);
  let scheduledConfiguredMcp:
    | Awaited<ReturnType<typeof materializeStaticMcpToolsForScheduledHarnessRun>>
    | undefined = undefined;
  // Requester-scoped MCP: dynamic tools on a shared thread (never harness-native MCP).
  // Specs come from the session advertised-catalog cache so fingerprints stay stable.
  let scopedMcpTools: Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>> =
    undefined;
  let rejectedScheduledMcpAuthorityNames = new Set<string>();
  try {
    const scheduledAccountMcp =
      authenticatedScheduledMode && params.scheduledToolPolicy?.mode === "account";
    const hasRequesterScopedMcp = bundleMcpThreadConfig.requesterScopedServerNames.length > 0;
    const hasFiniteScheduledAccountCap = hasExplicitFiniteCodexToolAllowlist(params.toolsAllow);
    const mayResolveBackgroundMcp =
      scheduledAccountMcp && hasRequesterScopedMcp && hasFiniteScheduledAccountCap;
    const missingScheduledAccountCap =
      scheduledAccountMcp && hasRequesterScopedMcp && !hasFiniteScheduledAccountCap;
    scopedMcpTools =
      authenticatedScheduledMode && !mayResolveBackgroundMcp
        ? missingScheduledAccountCap
          ? {
              tools: [],
              advertisedTools: [],
              allocatedToolNames: [],
              diagnosticNotice:
                "Configured MCP is incomplete for this scheduled run: the account automation has no explicit finite toolsAllow. Do not claim MCP-backed work succeeded; report this blocker to the operator.",
              dispose: async () => undefined,
            }
          : undefined
        : await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: effectiveWorkspace,
            agentDir: policyContext.agentDir,
            cfg: params.config,
            manifestRegistry: bundleManifestRegistry,
            toolOverrides: codexMcpToolOverrides,
            // Account-owned scheduled runs may resolve only providers that explicitly
            // accept canonical agent + session identity without a live requester.
            // Never replay the creator's sender, account, channel, or conversation:
            // per-requester OAuth and requester-required resolvers must stay closed.
            ...(mayResolveBackgroundMcp
              ? {}
              : {
                  requesterSenderId: params.senderId,
                  agentAccountId: params.agentAccountId,
                  messageChannel: params.messageChannel ?? params.messageProvider,
                  chatType: params.chatType,
                  conversationId: params.chatId ?? params.groupId ?? params.messageTo,
                }),
            agentId: sessionAgentId,
            runtimeGeneration: params.lifecycleGeneration,
            traceId: params.diagnosticTrace?.traceId,
            reservedToolNames,
            toolsAllow: params.toolsAllow,
            policyContext,
            ...(mayResolveBackgroundMcp
              ? { scheduledCodexApproval: { autoApprove: autoApproveScheduledMcp } }
              : {}),
            warn: (message) => embeddedAgentLog.warn(message),
          });
    if (mayResolveBackgroundMcp && !scopedMcpTools) {
      scopedMcpTools = {
        tools: [],
        advertisedTools: [],
        allocatedToolNames: [],
        diagnosticNotice:
          "Configured MCP is incomplete for this scheduled run: the background connection catalog is unavailable. Do not claim MCP-backed work succeeded; report this blocker to the operator.",
        dispose: async () => undefined,
      };
    }
    const resolverAllocationIncomplete = shouldWithholdStaticCodexMcp({
      scheduledAccountMcp,
      hasRequesterScopedMcp,
      toolsAllow: params.toolsAllow,
      resolverDiagnosticNotice: scopedMcpTools?.diagnosticNotice,
    });
    // Resolver tools are allocated before static tools, matching ordinary owner turns
    // where resolver tools are dynamic and static MCP remains native. A canonical
    // cross-partition check below closes the remaining catalog-growth ambiguity.
    // If any scoped resolver catalog is incomplete, do not project static MCP at
    // all: an unreserved collision could otherwise transfer a persisted tool name
    // (and its finite authority) between unrelated canonical tools across runs.
    scheduledConfiguredMcp =
      ownsScheduledConfiguredMcpSurface && !resolverAllocationIncomplete
        ? await materializeStaticMcpToolsForScheduledHarnessRun({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: effectiveWorkspace,
            agentDir: policyContext.agentDir,
            cfg: params.config,
            manifestRegistry: bundleManifestRegistry,
            reservedToolNames: [
              ...reservedToolNames,
              ...(scopedMcpTools?.allocatedToolNames ?? []),
            ],
            nameOwnershipBaseReservedToolNames: reservedToolNames,
            toolsAllow: params.toolsAllow,
            toolOverrides: codexMcpToolOverrides,
            autoApproveCodexAppServerApprovals: autoApproveScheduledMcp,
            policyContext,
            warn: (message) => embeddedAgentLog.warn(message),
          })
        : undefined;
    if (scheduledAccountMcp) {
      const mcpIdentityBindings = resolveScheduledCodexMcpIdentityBindings({
        bindings: params.scheduledToolPolicy?.mcpToolBindings,
        allocations: [
          ...(scopedMcpTools?.mcpNameAllocations ?? []),
          ...(scheduledConfiguredMcp?.mcpNameAllocations ?? []),
        ],
        exposedNames: [
          ...(scopedMcpTools?.tools.map((tool) => tool.name) ?? []),
          ...(scopedMcpTools?.advertisedTools.map((tool) => tool.name) ?? []),
          ...(scheduledConfiguredMcp?.tools.map((tool) => tool.name) ?? []),
        ],
        persistedCapNames: params.toolsAllow,
      });
      rejectedScheduledMcpAuthorityNames = new Set(mcpIdentityBindings.rejectedNames);
      if (scopedMcpTools) {
        scopedMcpTools.tools = scopedMcpTools.tools.filter((tool) =>
          mcpIdentityBindings.allowedNames.has(tool.name.trim().toLowerCase()),
        );
        scopedMcpTools.advertisedTools = scopedMcpTools.advertisedTools.filter((tool) =>
          mcpIdentityBindings.allowedNames.has(tool.name.trim().toLowerCase()),
        );
      }
      if (scheduledConfiguredMcp) {
        scheduledConfiguredMcp.tools = scheduledConfiguredMcp.tools.filter((tool) =>
          mcpIdentityBindings.allowedNames.has(tool.name.trim().toLowerCase()),
        );
      }
      if (mcpIdentityBindings.rejectedNames.length > 0) {
        const notice =
          `Configured MCP is incomplete for this scheduled run: persisted tool identity no longer matches (${formatScheduledMcpIdentityMismatch(mcpIdentityBindings.rejectedNames)}). ` +
          "No mismatched MCP tool was exposed; reauthorize the automation from a current owner turn.";
        if (scopedMcpTools) {
          scopedMcpTools.diagnosticNotice = [scopedMcpTools.diagnosticNotice, notice]
            .filter(Boolean)
            .join(" ");
        } else if (scheduledConfiguredMcp) {
          scheduledConfiguredMcp.diagnosticNotice = [
            scheduledConfiguredMcp.diagnosticNotice,
            notice,
          ]
            .filter(Boolean)
            .join(" ");
        } else {
          scopedMcpTools = {
            tools: [],
            advertisedTools: [],
            allocatedToolNames: [],
            diagnosticNotice: notice,
            dispose: async () => undefined,
          };
        }
      }
    }
    // Restricted dynamic-tool profiles (private QA, exclusion lists) gate scoped
    // MCP tools exactly like every other dynamic tool. Filter both lists with the
    // same rule so execution and advertised specs stay name-aligned.
    const scopedExecutable = filterCodexDynamicTools(
      [...(scheduledConfiguredMcp?.tools ?? []), ...(scopedMcpTools?.tools ?? [])],
      pluginConfig,
    );
    const scopedAdvertised = filterCodexDynamicTools(
      [...(scheduledConfiguredMcp?.tools ?? []), ...(scopedMcpTools?.advertisedTools ?? [])],
      pluginConfig,
    );
    // A persisted MCP grant owns its allocated name across the complete dynamic
    // surface. If MCP moves or disappears, do not let an ordinary dynamic tool
    // inherit that exact authority-bearing name.
    const executableBaseTools = tools.filter(
      (tool) => !rejectedScheduledMcpAuthorityNames.has(tool.name.trim().toLowerCase()),
    );
    const advertisedBaseTools = registeredTools.filter(
      (tool) => !rejectedScheduledMcpAuthorityNames.has(tool.name.trim().toLowerCase()),
    );
    const toolsWithScopedMcp =
      scopedExecutable.length > 0
        ? [...executableBaseTools, ...scopedExecutable]
        : executableBaseTools;
    const registeredWithScopedMcp =
      scopedAdvertised.length > 0
        ? [...advertisedBaseTools, ...scopedAdvertised]
        : advertisedBaseTools;
    const hookContext = {
      agentId: sessionAgentId,
      config: params.config,
      contextWindowTokens: params.contextTokenBudget ?? params.model.contextWindow,
      workspaceDir: effectiveWorkspace,
      remoteWorkspaceRoot: connection.appServer.remoteWorkspaceRoot,
      remoteWorkspaceRequestTimeoutMs: connection.appServer.requestTimeoutMs,
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      runId: params.runId,
      channelId: hookChannelId,
      currentChannelProvider: resolveCodexMessageToolProvider(params),
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentMessageId: params.currentMessageId,
      currentThreadId: params.currentThreadTs,
      replyToMode: params.replyToMode,
      hasRepliedRef: params.hasRepliedRef,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      onToolOutcome: onCodexToolOutcome,
      allocateToolOutcomeOrdinal: allocateCodexToolOutcomeOrdinal,
      trigger: params.trigger,
      approvalReviewerDeviceId: params.approvalReviewerDeviceId,
      ...(hasRequester ? { requester } : {}),
      ...(turnSourceChannel ? { turnSourceChannel } : {}),
      ...(turnSourceTo ? { turnSourceTo } : {}),
      ...(params.agentAccountId ? { turnSourceAccountId: params.agentAccountId } : {}),
      ...(params.currentThreadTs !== undefined
        ? { turnSourceThreadId: params.currentThreadTs }
        : {}),
    };
    toolBridge = createCodexDynamicToolBridge({
      tools: toolsWithScopedMcp,
      registeredTools: registeredWithScopedMcp,
      signal: runAbortController.signal,
      computerContextEpoch,
      loading: resolveCodexDynamicToolsLoadingForRuntime(pluginConfig, effectiveRuntimeModelId, {
        connectionClass: connection.appServer.connectionClass,
      }),
      directToolNames: resolveCodexDynamicToolDirectNames(
        params,
        isHostScopedAgentToolActive("openclaw"),
      ),
      hookContext,
    });
    await captureFinalCodexCronCreatorToolAllowlist(
      cronCreatorToolAllowlist,
      cronCreatorToolAllowlistCaptureRef,
      toolBridge.availableTools,
    );
    if (
      !authenticatedScheduledMode &&
      bundleMcpThreadConfig.staticServerNames.length > 0 &&
      !canResolveScheduledConfiguredMcpCreatorAuthority
    ) {
      // Native configured MCP is model-visible but absent from this dynamic-tool list.
      // Keep the names for finite intersections, but never certify a partial default cap.
      delete cronCreatorToolAllowlistCaptureRef.value;
    }
    if (requiresScheduledCodexAppAuthority) {
      // Native apps are not represented in the OpenClaw dynamic-tool list.
      // Require the exact-thread resolver before certifying a default cap.
      delete cronCreatorToolAllowlistCaptureRef.value;
    }
    if (canResolveAnyScheduledCreatorAuthority) {
      resolveCreatorAuthorityImpl = async (options) => {
        options?.signal?.throwIfAborted();
        if (codexAppAuthorityUnavailableReason) {
          throw new Error(codexAppAuthorityUnavailableReason);
        }
        if (!toolBridge) {
          throw new Error("cron creator authority resolver lost the active tool bridge");
        }
        const authorityTools: Array<string | { name: string; pluginId?: string }> = [];
        const captureRef: {
          value?: { version: 1; source: "final-executable-surface" };
        } = {};
        await captureFinalCodexCronCreatorToolAllowlist(
          authorityTools,
          captureRef,
          toolBridge.availableTools,
        );
        if (!captureRef.value) {
          throw new Error("cron creator authority snapshot did not produce provenance");
        }
        const appSource = scheduledAppAuthoritySourceRef.current;
        const runtimeAuthority =
          canResolveScheduledCodexAppAuthority && preparedChatgptAuth
            ? appSource
              ? await captureScheduledCodexAppAuthority({
                  ...appSource,
                  ...preparedChatgptAuth,
                  signal: options?.signal,
                })
              : (() => {
                  throw new Error(
                    "Codex app authority is unavailable before the exact creator thread is active. Retry this automation mutation from the current owner turn.",
                  );
                })()
            : undefined;
        if (!canResolveScheduledConfiguredMcpCreatorAuthority) {
          options?.signal?.throwIfAborted();
          return Object.freeze({
            tools: Object.freeze(authorityTools.map((entry) => Object.freeze(entry))),
            provenance: Object.freeze(captureRef.value),
            ...(runtimeAuthority ? { runtimeAuthority } : {}),
          });
        }
        const authorityRuntimeId = `cron-authority:${params.runId}`;
        let materialized: Awaited<
          ReturnType<typeof materializeStaticMcpToolsForScheduledHarnessRun>
        >;
        try {
          materialized = await materializeStaticMcpToolsForScheduledHarnessRun({
            sessionId: authorityRuntimeId,
            workspaceDir: effectiveWorkspace,
            agentDir: policyContext.agentDir,
            cfg: params.config,
            manifestRegistry: bundleManifestRegistry,
            reservedToolNames: toolBridge.availableTools.map((tool) => tool.name),
            toolsAllow: params.toolsAllow,
            toolOverrides: codexMcpToolOverrides,
            autoApproveCodexAppServerApprovals: shouldAutoApproveCodexAppServerApprovals(
              connection.appServer,
            ),
            policyContext,
            warn: (message) => embeddedAgentLog.warn(message),
            retireSessionRuntimeAfterDispose: true,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Configured MCP discovery failed while resolving inherited automation authority: ${detail}. Retry after the server is available, or provide an explicit finite toolsAllow list containing only currently visible tools; no automation changes were saved.`,
            { cause: error },
          );
        }
        try {
          options?.signal?.throwIfAborted();
          if (materialized.diagnosticNotice) {
            throw new Error(
              `${materialized.diagnosticNotice} Sign in to the affected MCP server and retry, or provide an explicit finite toolsAllow list containing only currently visible tools. No automation changes were saved.`,
            );
          }
          // Default authority contains model-callable tools only. App-only projections
          // gate view callbacks and must never become headless scheduled capability.
          const projectedConfiguredMcp = projectCodexExecutableDynamicTools({
            tools: filterCodexDynamicTools(materialized.tools, pluginConfig),
            hookContext,
          });
          await captureFinalCodexCronCreatorToolAllowlist(authorityTools, captureRef, [
            ...toolBridge.availableTools,
            ...projectedConfiguredMcp.availableTools,
          ]);
          if (!captureRef.value) {
            throw new Error("configured MCP authority snapshot did not produce provenance");
          }
          options?.signal?.throwIfAborted();
          return Object.freeze({
            tools: Object.freeze(authorityTools.map((entry) => Object.freeze(entry))),
            provenance: Object.freeze(captureRef.value),
            ...(runtimeAuthority ? { runtimeAuthority } : {}),
          });
        } finally {
          await materialized.dispose();
        }
      };
    }
    return {
      tools: toolsWithScopedMcp,
      registeredTools: registeredWithScopedMcp,
      scopedMcpTools,
      scheduledConfiguredMcp,
      configuredMcpOwnershipVersion: ownsScheduledConfiguredMcpSurface ? (1 as const) : undefined,
      cronCreatorToolAllowlist,
      cronCreatorToolAllowlistCaptureRef,
      scheduledAppAuthoritySourceRef,
      dynamicToolParams,
      compactionPlanState,
      computerContextEpoch,
      runCleanups,
      toolBridge,
      toolState,
      toolOutcomeOrdinals,
      suppressedDynamicToolOutcomeOrdinals,
      onCodexToolOutcome,
      allocateCodexToolOutcomeOrdinal,
      runtimeYieldCompletionClaim,
    };
  } catch (error) {
    // Materialized runtimes are attempt-owned only after this function returns.
    // Dispose here when filtering, schema projection, or bridge setup fails first.
    await scopedMcpTools?.dispose();
    await scheduledConfiguredMcp?.dispose();
    throw error;
  }
}

export type CodexAttemptTools = Awaited<ReturnType<typeof prepareCodexAttemptTools>>;
