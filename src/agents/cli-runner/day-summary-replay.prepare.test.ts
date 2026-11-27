import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
  CliBackendPlugin,
} from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { createCliLiveSessionCapability } from "./cli-live-session-registry.js";
import { readCliDaySummaryReplay, resetCliDaySummaryReplaysForTest } from "./day-summary-replay.js";
import { executePreparedCliRun } from "./execute.js";
import {
  buildCliLiveSessionFingerprintParts,
  changedCliLiveSessionFingerprintPart,
  changedCliLiveSessionAuthorityPart,
} from "./live-session-fingerprint.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

const nativeSessionId = "5b1d1f7e-0c1a-4f53-9d1e-6f0a3c2b9e11";
let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
const sent: Array<Pick<CliBackendExecuteContext, "args" | "env">> = [];

beforeEach(() => {
  sent.length = 0;
  resetCliDaySummaryReplaysForTest();
  const backend = buildAnthropicCliBackend();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...backend,
        pluginId: "anthropic",
        config: { ...backend.config, command: process.execPath },
        runtimeArtifact: undefined,
        prepareExecution: async (context) => ({
          ...(await backend.prepareExecution?.(context)),
          async *execute(input: CliBackendExecuteContext) {
            sent.push({ args: [...input.args], env: { ...input.env } });
            yield { type: "result", subtype: "success", result: "ok", session_id: nativeSessionId };
          },
        }),
      },
    ],
  });
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    getActiveMcpLoopbackRuntime: () => ({
      port: 31783,
      ownerToken: "fixture-owner",
      nonOwnerToken: "fixture-reader",
    }),
    createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
    mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
    bindMcpLoopbackClientGrantAdmission: () => true,
    revokeMcpLoopbackClientGrant: () => true,
    revokeMintedMcpLoopbackClientGrant: () => true,
    resolveMcpLoopbackPolicyTools,
    resolveMcpLoopbackScopedTools,
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    claudeCliSessionTranscriptHasContent: async () => true,
    claudeCliSessionTranscriptHasOrphanedToolUse: async () => false,
    getCliLiveSessionGeneration: () => undefined,
    transferMcpLoopbackClientGrant: () => true,
    loadManifestModelCatalog: () => [],
  });
  fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
});

afterEach(async () => {
  await fixture.cleanup();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it("runs the silent day summary in the warm process the person's turn left", async () => {
  const { dir, sessionTarget } = fixture.session;
  vi.stubEnv("HOME", dir);
  const config = {
    agents: { defaults: { workspace: dir, model: { primary: "anthropic/claude-opus-4-6" } } },
    session: { store: sessionTarget.storePath },
    plugins: { enabled: false },
    tools: { allow: ["read"] },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(config);
  const person = (cliSessionBinding?: Record<string, unknown>) =>
    fixture.prepare({
      config,
      sessionEntry: loadSessionEntry(sessionTarget),
      sessionKey: sessionTarget.sessionKey,
      provider: "claude-cli",
      model: "opus",
      trigger: "user",
      prompt: "What is on today?",
      sourceReplyDeliveryMode: "automatic",
      ...(cliSessionBinding ? { cliSessionBinding: cliSessionBinding as never } : {}),
    });

  const first = await person();
  let binding: Record<string, unknown>;
  try {
    await executePreparedCliRun(first);
    binding = {
      sessionId: nativeSessionId,
      authEpoch: first.authEpoch,
      authEpochVersion: first.authEpochVersion,
      extraSystemPromptHash: first.extraSystemPromptHash,
      messageToolPolicyHash: first.messageToolPolicyHash,
      promptToolNamesHash: first.promptToolNamesHash,
      cwdHash: first.cwdHash,
      mcpConfigHash: first.preparedBackend.mcpConfigHash,
      mcpResumeHash: first.preparedBackend.mcpResumeHash,
    };
  } finally {
    await first.preparedBackend.cleanup?.();
  }
  replaceSessionEntrySync(sessionTarget, {
    sessionId: sessionTarget.sessionId,
    updatedAt: 2,
    cliSessionBindings: { "claude-cli": binding as never },
  });

  const warm = await person(binding);
  let summary: PreparedCliRunContext | undefined;
  try {
    expect(warm.reusableCliSession).toEqual({ mode: "reuse", sessionId: nativeSessionId });
    await executePreparedCliRun(warm, nativeSessionId);
    const replay = readCliDaySummaryReplay({ sessionKey: sessionTarget.sessionKey });
    expect(replay).toBeDefined();

    summary = await fixture.prepare({
      ...replay!.params,
      sessionEntry: loadSessionEntry(sessionTarget),
      sessionKey: sessionTarget.sessionKey,
      provider: "claude-cli",
      prompt: "[Memory upkeep from OpenClaw, not from the Owner.]",
      runId: "day-summary-run",
      trigger: "user",
      controlOperation: "day-summary",
      cliSessionBinding: binding as never,
      cliSessionId: nativeSessionId,
      persistAssistantTranscript: false,
      timeoutMs: 1_000,
    });
    await executePreparedCliRun(summary, nativeSessionId);
    const [warmTurn, summaryTurn] = [sent[1]!, sent[2]!];

    // The silent summary is rebuilt without tools, so its prompt and tool flags never
    // match the person's process, while account, credential, model and workspace do.
    const warmParts = buildCliLiveSessionFingerprintParts({
      context: warm,
      argv: warmTurn.args,
      env: warmTurn.env,
    });
    const summaryParts = buildCliLiveSessionFingerprintParts({
      context: summary,
      argv: summaryTurn.args,
      env: summaryTurn.env,
    });
    const flag = (args: readonly string[], name: string) => args[args.indexOf(name) + 1];
    expect(flag(summaryTurn.args, "--disallowedTools")?.split(",")).toContain("mcp__*");
    expect(summaryTurn.args).not.toContain("--allowedTools");
    expect(warmTurn.args).toContain("--allowedTools");
    expect(changedCliLiveSessionFingerprintPart(warmParts, summaryParts)).toBe("argv");
    expect(changedCliLiveSessionAuthorityPart(warmParts, summaryParts)).toBeUndefined();

    // So it runs in that warm process as is, reading the conversation from the cache;
    // its tool calls go through its own MCP grant, transferred to the process.
    expect(warm.preparedBackend.mcpClientGrantCapture).toBeDefined();
    expect(summary.preparedBackend.mcpClientGrantCapture).toBeDefined();
    const capture = (context: PreparedCliRunContext, key: string) =>
      context.preparedBackend.mcpClientGrantCapture ? { captureKey: key } : {};
    const warmCapability = createCliLiveSessionCapability({
      context: warm,
      argv: warmTurn.args,
      env: warmTurn.env,
      beginCapture: vi.fn(),
      abortSignal: new AbortController().signal,
      ...capture(warm, "warm-capture"),
    });
    const handle: CliBackendLiveSessionHandle = {
      generation: "warm-person-process",
      fingerprint: warmCapability.fingerprint,
      isIdle: () => true,
      close: () => warmCapability.remove(handle),
      waitForExit: async () => {},
    };
    warmCapability.register(handle);
    try {
      const summaryCapability = createCliLiveSessionCapability({
        context: summary,
        argv: summaryTurn.args,
        env: summaryTurn.env,
        beginCapture: vi.fn(),
        abortSignal: new AbortController().signal,
        requiredGeneration: handle.generation,
        ...capture(summary, "summary-capture"),
      });
      expect(summaryCapability.current()).toBe(handle);
      summaryCapability.activate(handle);
    } finally {
      warmCapability.remove(handle);
    }
  } finally {
    await warm.preparedBackend.cleanup?.();
    await summary?.preparedBackend.cleanup?.();
  }
});
