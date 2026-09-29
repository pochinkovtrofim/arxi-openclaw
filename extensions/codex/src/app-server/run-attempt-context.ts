import { createHash } from "node:crypto";
import path from "node:path";
import {
  bootstrapHarnessContextEngine,
  buildAgentHookContextChannelFields,
  buildHarnessContextEngineRuntimeContext,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  getAgentHarnessHookRunner,
  isHostScopedAgentToolActive,
  resolveContextEngineOwnerPluginId,
  runHarnessContextEngineMaintenance,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  buildCodexWorkspaceBootstrapContext,
  getCodexWorkspaceMemoryToolNames,
  readMirroredSessionHistoryMessages,
  renderCodexSkillsCollaborationInstructions,
  restoreCodexMandatoryPersonalBootstrap,
} from "./attempt-context.js";
import {
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
  resolveCodexContinuityProjectionMaxChars,
  type CodexProjectedContextRange,
} from "./context-engine-projection.js";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { joinPresentSections } from "./run-attempt-state.js";
import type { CodexAttemptTools } from "./run-attempt-tool-setup.js";
import {
  buildDeveloperInstructions,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";

export async function prepareCodexAttemptContext(
  runtime: CodexAttemptRuntime,
  attemptTools: CodexAttemptTools,
) {
  const {
    connection,
    runtimeParams,
    activeSessionId,
    activeSessionFile,
    buildActiveRunAttemptParams,
    effectiveContextWindowInfo,
    effectiveContextTokenBudget,
    effectiveRuntimeProviderId,
    effectiveRuntimeModelId,
    hookChannelId,
  } = runtime;
  const {
    params,
    sessionAgentId,
    contextSessionKey,
    activeContextEngine,
    initialStartupBindingHadInactiveThreadBootstrap,
    effectiveWorkspace,
    effectiveCwd,
    agentDir,
    usesSupervisionConnection,
    resolvedWorkspace,
    initialInactiveThreadBootstrapBindingForcedFreshStart,
    sandbox,
  } = connection;
  const { toolBridge } = attemptTools;
  const activeTranscriptTarget = {
    agentId: sessionAgentId,
    sessionFile: activeSessionFile,
    sessionId: activeSessionId,
    sessionKey: contextSessionKey,
    sessionTarget: params.sessionTarget,
  };
  const readFencedHistory = async () => {
    const transcriptReadFence = params.userTurnTranscriptRecorder?.getAdmissionReceipt();
    const messages = await readMirroredSessionHistoryMessages({
      ...activeTranscriptTarget,
      signal: connection.runAbortController.signal,
      contextTokenBudget: effectiveContextTokenBudget,
      ...(transcriptReadFence ? { admission: transcriptReadFence } : {}),
    });
    connection.runAbortController.signal.throwIfAborted();
    connection.assertCurrent();
    return messages;
  };
  const historyState = {
    messages:
      !activeContextEngine && initialStartupBindingHadInactiveThreadBootstrap
        ? []
        : ((await readFencedHistory()) ?? []),
  };
  const hadSessionTranscriptState = historyState.messages.length > 0;
  const hookContextWindowFields = {
    ...(effectiveContextWindowInfo?.tokens
      ? { contextTokenBudget: effectiveContextWindowInfo.tokens }
      : effectiveContextTokenBudget
        ? { contextTokenBudget: effectiveContextTokenBudget }
        : {}),
    ...(effectiveContextWindowInfo?.source
      ? { contextWindowSource: effectiveContextWindowInfo.source }
      : {}),
    ...(effectiveContextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: effectiveContextWindowInfo.referenceTokens }
      : {}),
  };
  const personalPromptState: {
    packet?: {
      text: string;
      budgetTokens: number;
      expansionReason?: "complex_source_read";
      sourceRefs?: readonly { kind: string; sha256: string }[];
    };
    mandatorySourcesComplete: boolean;
  } = { mandatorySourcesComplete: true };
  const legacySegments: Array<{
    name: "USER.md" | "MEMORY.md";
    path: string;
    text: string;
    sha256: string;
    mandatory: true;
  }> = [];
  const personalPrompt = {
    legacySegments,
    countInputUtf8UpperBound: (input: { instructions: string; prompt: string }) =>
      Buffer.byteLength([input.instructions, input.prompt].join("\n\n"), "utf8"),
    registerPreparedPacket: (packet: {
      text: string;
      budgetTokens: number;
      expansionReason?: "complex_source_read";
      sourceRefs?: readonly { kind: string; sha256: string }[];
    }) => {
      if (!packet.text || (packet.budgetTokens !== 8_000 && packet.budgetTokens !== 16_000)) {
        throw new Error("Codex personal packet registration is invalid");
      }
      if (personalPromptState.packet) {
        if (
          personalPromptState.packet.text !== packet.text ||
          personalPromptState.packet.budgetTokens !== packet.budgetTokens ||
          personalPromptState.packet.expansionReason !== packet.expansionReason
        ) {
          throw new Error("Codex personal packet changed during prompt rebuild");
        }
        return;
      }
      // The generic bootstrap may trim USER for ordinary Codex sessions. An
      // owner packet requires the complete constraints: restore them at their
      // projection producer, then let the final gate accept or needs_expansion.
      personalPromptState.mandatorySourcesComplete =
        restoreCodexMandatoryPersonalBootstrap(workspaceBootstrapContext).status === "complete";
      const userSegment = legacySegments.find((segment) => segment.name === "USER.md");
      if (userSegment && workspaceBootstrapContext.turnScopedDeveloperInstructions) {
        const file = workspaceBootstrapContext.turnScopedDeveloperInstructionFiles?.find(
          (entry) => path.basename(entry.path).toLowerCase() === "user.md",
        );
        if (file) {
          userSegment.text = `### ${file.path}\n\n${file.content}\n\n`;
        }
        userSegment.sha256 = createHash("sha256").update(userSegment.text).digest("hex");
      }
      personalPromptState.packet = {
        ...packet,
        ...(packet.sourceRefs ? { sourceRefs: packet.sourceRefs.map((ref) => ({ ...ref })) } : {}),
      };
    },
  };
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: contextSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    // Native-owned models are confirmed after startup; hooks must not publish
    // stale bindings or private transport overrides as the selected model.
    ...(!usesSupervisionConnection &&
    connection.mutable.startupBinding?.preserveNativeModel !== true
      ? { modelProviderId: params.provider, modelId: params.modelId }
      : {}),
    trigger: params.trigger,
    inputProvenance: params.inputProvenance,
    ...buildAgentHookContextChannelFields({
      sessionKey: contextSessionKey,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      currentChannelId: hookChannelId,
      messageTo: params.messageTo,
      senderId: params.senderId,
      agentAccountId: params.agentAccountId,
    }),
    channelContext: params.channelContext,
    personalPrompt,
    ...hookContextWindowFields,
  };
  const hookRunner = getAgentHarnessHookRunner();
  const buildActiveContextEngineRuntimeContext = () =>
    buildHarnessContextEngineRuntimeContext({
      attempt: buildActiveRunAttemptParams(),
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      agentDir,
      activeAgentId: sessionAgentId,
      contextEnginePluginId: resolveContextEngineOwnerPluginId(activeContextEngine),
      tokenBudget: effectiveContextTokenBudget,
    });
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile: hadSessionTranscriptState,
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: contextSessionKey,
      sessionFile: activeSessionFile,
      sessionTarget: params.sessionTarget,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      transcriptReadFence: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: effectiveRuntimeProviderId,
      requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
      modelId: effectiveRuntimeModelId,
      fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
      degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyState.messages = (await readFencedHistory()) ?? historyState.messages;
  }
  // The admission fence intentionally excludes this logical turn's committed results.
  historyState.messages.push(...(params.pluginRuntimeRefreshMessages ?? []));
  const memoryToolNames = getCodexWorkspaceMemoryToolNames(toolBridge.availableSpecs);
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params: runtimeParams,
    resolvedWorkspace: runtimeParams.bootstrapWorkspaceDir ?? resolvedWorkspace,
    executionWorkspace: resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: contextSessionKey,
    sessionAgentId,
    memoryToolNames,
    ringZeroActive:
      isHostScopedAgentToolActive("openclaw") &&
      isSystemAgentOnlyCodexDynamicToolAllowlist(runtimeParams.toolsAllow),
    sandboxed: sandbox?.enabled === true,
  });
  const userFile = workspaceBootstrapContext.contextFiles.find(
    (file) => path.basename(file.path).toLowerCase() === "user.md",
  );
  const memoryFile = workspaceBootstrapContext.promptContextFiles?.find(
    (file) => path.basename(file.path).toLowerCase() === "memory.md",
  );
  for (const [name, file, text] of [
    ["USER.md", userFile, workspaceBootstrapContext.turnScopedDeveloperInstructions],
    ["MEMORY.md", memoryFile, workspaceBootstrapContext.promptContext],
  ] as const) {
    if (file && text) {
      const block = `${name === "USER.md" ? "###" : "##"} ${file.path}\n\n${file.content}`;
      // Attribute the personal file's exact rendered block, not sibling SOUL,
      // IDENTITY or TOOLS documents in the same native instruction leaf.
      const renderedBlock = text.includes(block + "\n\n") ? block + "\n\n" : block;
      legacySegments.push({
        name,
        path: file.path,
        text: renderedBlock,
        sha256: createHash("sha256").update(renderedBlock).digest("hex"),
        mandatory: true,
      });
    }
  }
  // A thread keeps the bounded agent-workspace snapshot captured at creation.
  // Workspace edits take effect only in the next session.
  const agentWorkspaceDeveloperInstructions = workspaceBootstrapContext.threadDeveloperInstructions
    ? (connection.mutable.startupBinding?.agentWorkspaceDeveloperInstructions ??
      workspaceBootstrapContext.threadDeveloperInstructions)
    : undefined;
  const baseDeveloperInstructions = joinPresentSections(
    buildDeveloperInstructions(runtimeParams, {
      dynamicTools: toolBridge.availableSpecs,
    }),
    agentWorkspaceDeveloperInstructions,
  );
  const watchedSessionsContext = buildCodexWatchedSessionsContext({
    attempt: runtimeParams,
    dynamicTools: toolBridge.availableSpecs,
    sessionKey: contextSessionKey,
    sandboxed: sandbox?.enabled === true,
  });
  const buildOpenClawPromptContext = (includeWorkspaceReferences: boolean) =>
    buildCodexOpenClawPromptContext({
      params: runtimeParams,
      workspacePromptContext: includeWorkspaceReferences
        ? workspaceBootstrapContext.promptContext
        : undefined,
      watchedSessionsContext,
    });
  const skillsCollaborationInstructions = renderCodexSkillsCollaborationInstructions({
    attempt: runtimeParams,
    skillsPrompt: params.skillsSnapshot?.prompt,
  });
  const promptState = {
    promptText: params.prompt,
    promptContextRange: undefined as CodexProjectedContextRange | undefined,
    developerInstructions: baseDeveloperInstructions,
    prePromptMessageCount: historyState.messages.length,
    contextEngineProjection: undefined as CodexContextEngineThreadBootstrapProjection | undefined,
    precomputedStaleBindingContinuityProjectionApplied: false,
    staleBindingContinuityForcedFreshStart: false,
    // Set by the no-engine continuity appliers; gates calibration recording so a
    // dense direct or active-engine prompt can never persist a density sample
    // that later shrinks continuity history it did not measure.
    noEngineContinuityProjectionApplied: false,
    inactiveThreadBootstrapBindingForcedFreshStart:
      initialInactiveThreadBootstrapBindingForcedFreshStart,
    // SAFETY: prompt preparation initializes these groups before turn input is built.
    continuityImages: undefined as
      | Array<{
          contextStart: number;
          images: NonNullable<CodexAttemptRuntime["runtimeParams"]["images"]>;
        }>
      | undefined,
    continuityContextStart: 0,
  };
  const codexContextProjectionMaxChars = resolveCodexContextEngineProjectionMaxChars({
    contextTokenBudget: effectiveContextTokenBudget,
    reserveTokens: resolveCodexContextEngineProjectionReserveTokens(),
  });
  const codexContinuityProjectionMaxChars = resolveCodexContinuityProjectionMaxChars({
    contextTokenBudget: effectiveContextTokenBudget,
    calibration: connection.mutable.continuityCalibration,
  });
  return {
    runtime,
    attemptTools,
    activeTranscriptTarget,
    historyState,
    hookContext,
    personalPromptState,
    hookContextWindowFields,
    hookRunner,
    buildActiveContextEngineRuntimeContext,
    workspaceBootstrapContext,
    agentWorkspaceDeveloperInstructions,
    baseDeveloperInstructions,
    buildOpenClawPromptContext,
    skillsCollaborationInstructions,
    promptState,
    codexContextProjectionMaxChars,
    codexContinuityProjectionMaxChars,
  };
}

export type CodexAttemptContext = Awaited<ReturnType<typeof prepareCodexAttemptContext>>;
