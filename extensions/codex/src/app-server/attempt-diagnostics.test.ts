// Codex tests cover attempt diagnostics plugin behavior.
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { describe, expect, it } from "vitest";
import {
  buildCodexPluginThreadConfigEligibilityLogData,
  createCodexModelCallDiagnosticEmitter,
} from "./attempt-diagnostics.js";
import { resolveCodexPluginsPolicy } from "./config.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";

describe("Codex app-server attempt diagnostics", () => {
  it("emits content-free prompt size attribution on model-call lifecycle events", async () => {
    const inputMessages = [{ role: "user", content: "sensitive user prompt" }];
    const systemPrompt = "sensitive system prompt";
    const tools = [
      {
        name: "memory_search",
        description: "sensitive tool description",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ];
    const diagnosticToolDefinitions = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event));

    try {
      const emitter = createCodexModelCallDiagnosticEmitter({
        baseFields: {
          runId: "run-prompt-stats",
          callId: "call-prompt-stats",
          provider: "openai",
          model: "gpt-5.6-sol",
        },
        capture: {},
        tools,
        buildInputMessages: () => inputMessages,
        buildSystemPrompt: () => systemPrompt,
      });
      emitter.emitStarted();
      emitter.emitCompleted({ assistantTexts: ["sensitive answer"] });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
    }

    const expectedPromptStats = {
      inputMessagesCount: 1,
      inputMessagesChars: JSON.stringify(inputMessages).length,
      systemPromptChars: systemPrompt.length,
      toolDefinitionsCount: 1,
      toolDefinitionsChars: JSON.stringify(diagnosticToolDefinitions).length,
      totalChars:
        JSON.stringify(inputMessages).length +
        systemPrompt.length +
        JSON.stringify(diagnosticToolDefinitions).length,
    };
    expect(
      events
        .filter(
          (
            event,
          ): event is Extract<
            DiagnosticEventPayload,
            { type: "model.call.started" | "model.call.completed" }
          > =>
            (event.type === "model.call.started" || event.type === "model.call.completed") &&
            event.callId === "call-prompt-stats",
        )
        .map((event) => ({ type: event.type, promptStats: event.promptStats })),
    ).toEqual([
      { type: "model.call.started", promptStats: expectedPromptStats },
      { type: "model.call.completed", promptStats: expectedPromptStats },
    ]);
    expect(JSON.stringify(events)).not.toContain("sensitive");
  });

  it("redacts plugin thread config eligibility log data", () => {
    const appServer = {
      start: {
        transport: "websocket" as const,
        command: "codex",
        commandSource: "config" as const,
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-secret",
        headers: {
          Authorization: "Bearer secret",
          "X-Test-Token": "header-secret",
        },
        env: {
          CODEX_HOME: "/tmp/codex-home",
          OPENAI_API_KEY: "env-secret",
        },
      },
      codeModeOnly: false,
      loopDetectionPreToolUseRelay: true,
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 60_000,
      approvalPolicy: "never" as const,
      approvalsReviewer: "user" as const,
      sandbox: "danger-full-access" as const,
      connectionClass: "local-loopback" as const,
      remoteAppsSubstrate: "preconfigured" as const,
      serviceTier: "priority" as const,
    };
    const resolvedPluginPolicy = resolveCodexPluginsPolicy({
      codexPlugins: {
        enabled: true,
        allow_all_plugins: true,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    });

    const logData = buildCodexPluginThreadConfigEligibilityLogData({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      pluginThreadConfigRequired: true,
      resolvedPluginPolicy,
      enabledPluginConfigKeys: ["google-calendar"],
      pluginAppCacheKey: buildCodexPluginAppCacheKey({
        appServer,
        agentDir: "/tmp/agent",
        authProfileId: "openai:work",
        accountId: "account-work",
        envApiKeyFingerprint: "env-key",
      }),
      startupAuthProfileId: "openai:work",
      appServer,
    });

    expect(logData).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        enabled: true,
        policyConfigured: true,
        policyEnabled: true,
        allowAllPlugins: true,
        pluginConfigKeys: ["google-calendar"],
        enabledPluginConfigKeys: ["google-calendar"],
        appCacheKeyFingerprint: expect.stringMatching(/^sha256:/),
        authProfileId: "openai:work",
        appServerTransport: "websocket",
        appServerCommandSource: "config",
      }),
    );
    expect(logData).not.toHaveProperty("appCacheKeyInput");
    const serialized = JSON.stringify(logData);
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("env-secret");
    expect(serialized).not.toContain("/tmp/codex-home");
  });
});
