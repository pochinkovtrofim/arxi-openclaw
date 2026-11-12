import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
// Codex tests cover run attempt.context engine plugin behavior.
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createParams,
  createStartedThreadHarness,
  getRequestInputText,
  makeThreadBootstrapBinding,
  requireRecord,
  runCodexAppServerAttempt,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { withoutCodexTurnContextHandoffs } from "./test-support.js";

function requestMethodsExcludingSkillDiscovery(harness: {
  requests: ReadonlyArray<{ method: string; params?: unknown }>;
}) {
  return withoutCodexTurnContextHandoffs(harness.requests);
}

async function createSqliteParams(
  workspaceDir: string,
  storeName: string,
): Promise<EmbeddedRunAttemptParams> {
  const sessionId = "session-1";
  const sessionKey = "agent:main:session-1";
  const storePath = path.join(tempDir, `${storeName}.sqlite`);
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  const params = createParams(sessionFile, workspaceDir);
  const entry = { sessionFile, sessionId, updatedAt: Date.now() };
  await upsertSessionEntry({ agentId: "main", sessionKey, storePath, entry });
  params.sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  };
  const message = userMessage("hello", Date.now());
  params.userTurnTranscriptRecorder = {
    message,
    resolveMessage: async () => message,
    markRuntimePersisted() {},
    getAdmissionReceipt: () => undefined,
  } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
  return params;
}

function expectRequestInputTextContains(
  harness: ReturnType<typeof createStartedThreadHarness>,
  expected: string,
): void {
  expect(getRequestInputText(harness)).toContain(expected);
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt context-engine lifecycle", () => {
  it("reprojects thread-bootstrap context for native-disabled transient Codex threads", async () => {
    const restoreSandboxBackend = registerSandboxBackend(
      "codex-context-test-sandbox",
      async () => ({
        id: "codex-context-test-sandbox",
        runtimeId: "codex-context-test-runtime",
        runtimeLabel: "Codex Context Test Sandbox",
        workdir: "/workspace",
        buildExecSpec: async () => ({
          argv: ["true"],
          env: {},
          stdinMode: "pipe-closed" as const,
        }),
        runShellCommand: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        }),
      }),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    try {
      await writeCodexAppServerBinding(
        sessionFile,
        makeThreadBootstrapBinding({
          threadId: "thread-old",
          cwd: workspaceDir,
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
          epoch: "epoch-1",
        }),
      );
      const contextEngine = createContextEngine({
        assemble: vi.fn(async ({ prompt }) => ({
          messages: [
            assistantMessage("native-disabled context", 10),
            userMessage(prompt ?? "", 11),
          ],
          estimatedTokens: 42,
          systemPromptAddition: "context-engine system",
          contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
        })),
      });
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/start") {
          return threadStartResult("thread-transient");
        }
        if (method === "thread/resume") {
          throw new Error("native-disabled turns should not resume the previous Codex thread");
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      params.contextEngine = contextEngine;
      params.config = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "codex-context-test-sandbox",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];
      setRuntimeConfigSnapshot(params.config ?? {});

      const run = runCodexAppServerAttempt(params);
      await Promise.race([
        harness.waitForMethod("turn/start"),
        run.then(() => {
          throw new Error("Codex attempt completed before turn/start");
        }),
      ]);

      expect(requestMethodsExcludingSkillDiscovery(harness)).toEqual([
        "config/read",
        "thread/start",
        "turn/start",
      ]);
      expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
      expectRequestInputTextContains(harness, "native-disabled context");

      await harness.completeTurn("completed", "thread-transient");
      await run;
    } finally {
      restoreSandboxBackend();
    }
  });

  it.each([
    {
      name: "Gateway-routed heartbeat",
      trigger: "user",
      bootstrapContextRunKind: "heartbeat",
    },
  ] as const)(
    "returns an exact terminal anchor for $name turns without finalizing inside Codex",
    async (testCase) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const afterTurn = vi.fn(
        async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
      );
      const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
      const contextEngine = createContextEngine({ afterTurn, maintain, bootstrap: undefined });
      const harness = createStartedThreadHarness();
      const params = await createSqliteParams(
        workspaceDir,
        `heartbeat-${testCase.bootstrapContextRunKind}`,
      );
      params.contextEngine = contextEngine;
      params.trigger = testCase.trigger;
      params.bootstrapContextRunKind = testCase.bootstrapContextRunKind;
      params.contextTokenBudget = 111;
      params.requestedModelId = "gpt-5.4-codex-primary";
      params.fallbackReason = "provider_unavailable";
      params.degradedReason = "context_overflow";

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn();
      const result = await run;

      expect(result.contextEngineTerminalAnchor).toMatchObject({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      });
      expect(afterTurn).not.toHaveBeenCalled();
      expect(maintain).not.toHaveBeenCalled();
    },
  );

  it("persists the admitted user prompt before an async item buffered during turn startup", async () => {
    const workspaceDir = path.join(tempDir, "workspace-early-async");
    const params = await createSqliteParams(workspaceDir, "early-async-order");
    const delivered = Promise.withResolvers<void>();
    params.onBlockReply = vi.fn(() => delivered.resolve());
    params.sandboxSessionKey = "agent:main:policy";
    params.contextEngine = createContextEngine();
    const beforeMessageWrite = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_message_write", handler: beforeMessageWrite }]),
    );
    const recorder = params.userTurnTranscriptRecorder;
    if (!recorder) {
      throw new Error("expected user turn transcript recorder");
    }
    recorder.markRuntimePersistencePending = vi.fn();
    recorder.markRuntimePersisted = vi.fn();
    recorder.markSentToProvider = vi.fn(() => {
      throw new Error("admission is not available before Codex turn/start");
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "startup-async",
              phase: "final_answer",
              delivery: "async",
              text: "Working on the request.",
            },
          },
        });
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await awaitGateBeforeSettlement(
      delivered.promise,
      run,
      "Codex attempt completed before delivering its buffered async item",
    );
    expect(params.onBlockReply).toHaveBeenCalledOnce();
    expect(recorder.markSentToProvider).not.toHaveBeenCalled();
    expect(recorder.markRuntimePersisted).toHaveBeenCalledOnce();
    expect(beforeMessageWrite).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
      { agentId: "main", sessionKey: params.sessionKey },
    );
    await harness.completeTurn();
    await run;

    const sessionTarget = params.sessionTarget;
    if (!sessionTarget?.sessionId || !sessionTarget.sessionKey) {
      throw new Error("expected a complete session transcript target");
    }
    const messages = (
      await readSessionTranscriptEvents({
        ...sessionTarget,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
      })
    )
      .map((event) => (event as { message?: { role?: string } }).message)
      .filter((message) => message !== undefined);
    expect(messages.slice(0, 2).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]).toMatchObject({ openclawAsyncDelivery: { itemId: "startup-async" } });
  });

  it("logs assemble failures as a formatted message instead of the raw error object", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("first baseline message", 1) as never,
    );
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      userMessage("second baseline message", 2) as never,
    );
    let preassemblyMessages: AgentMessage[] = [];
    let promptHookMessages: AgentMessage[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async (event) => {
            promptHookMessages = (event as { messages: AgentMessage[] }).messages;
            return {};
          },
        },
      ]),
    );
    const rawError = new Error("Authorization: Bearer sk-abcdefghijklmnopqrstuv");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ messages }) => {
        preassemblyMessages = messages.slice();
        messages.reverse();
        messages.pop();
        throw rawError;
      }),
      bootstrap: undefined,
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    const warning = warn.mock.calls.find(
      ([message]) => message === "context engine assemble failed; using Codex baseline prompt",
    );
    const details = requireRecord(warning?.[1], "assemble warning details");
    expect(typeof details.error).toBe("string");
    expect(warning?.[1]).not.toEqual({ error: rawError });
    expect(String(details.error)).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(promptHookMessages).toEqual(preassemblyMessages);
    expect(promptHookMessages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expectRequestInputTextContains(harness, params.prompt);
  });
});
