import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { getHoisted, resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

const hoisted = getHoisted();
beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(() => vi.restoreAllMocks());

// A before_tool_call hook on a bundle MCP tool must see the conversation and
// sender the MCP call itself carries (attempt-bundle-tools.ts): an approval
// bound in the hook is checked against the MCP call's identity.
describe("tool hook requester", () => {
  it.each([
    {
      name: "private chat",
      chatId: "telegram-chat:84",
      senderId: "84",
      want: {
        conversationId: "telegram-chat:84",
        chatType: "direct",
        channel: "telegram",
        senderId: "84",
        senderIsOwner: true,
      },
    },
    { name: "background run", want: undefined },
  ])("matches the MCP runtime's requester for a $name", async (scenario) => {
    const config: OpenClawConfig = { tools: { codeMode: false, toolSearch: { enabled: false } } };
    const admission = prepareSystemAgentRunAdmission(config, "requester", "main", "test");
    hoisted.createOpenClawCodingToolsMock.mockImplementation(() => []);
    // SAFETY: This fixture invokes only tool preparation; transcript/model execution fields
    // are deliberately absent. Existing harness mocks own those unrelated collaborators.
    const attempt = {
      config,
      runId: "requester",
      sessionId: "requester",
      sessionKey: "agent:main:main",
      agentDir: "/tmp/requester-agent",
      modelId: "test-model",
      provider: "anthropic",
      model: makeProviderModelFixture({
        id: "test-model",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
      authProfileStore: { version: 1, profiles: {} },
      admittedRunContext: await admission.admit("embedded"),
      ...(scenario.chatId
        ? {
            chatId: scenario.chatId,
            chatType: "direct",
            messageChannel: "telegram",
            senderId: scenario.senderId,
            senderIsOwner: true,
          }
        : {}),
    } as EmbeddedRunAttemptInternalParams;
    const result = await prepareEmbeddedAttemptToolBase({
      attempt,
      agentDir: attempt.agentDir!,
      setup: createAttemptSetupFixture({ sandboxSessionKey: attempt.sessionKey! }),
      markCoreToolStage: () => {},
      onYield: async () => {},
      runAbortController: new AbortController(),
      runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
      skillUsagePaths: [],
      skillsSnapshot: undefined,
      codeModeSkills: [],
      toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
    });
    try {
      expect(result.toolHookContext.requester).toEqual(scenario.want);
    } finally {
      await result.releaseTools("test-complete");
      result.toolSurfaceRuntime.cleanup();
      admission.close();
    }
  });
});
