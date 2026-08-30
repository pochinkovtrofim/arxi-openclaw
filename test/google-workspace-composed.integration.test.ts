import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "grammy/types";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAllowFrom } from "../extensions/telegram/src/bot-access.js";
import { isTelegramDmAccessAllowed } from "../extensions/telegram/src/dm-access.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "../extensions/telegram/src/group-access.js";
import { materializeBundleMcpToolsForRun } from "../src/agents/agent-bundle-mcp-materialize.js";
import {
  disposeAllSessionMcpRuntimes,
  getOrCreateSessionMcpRuntime,
} from "../src/agents/agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "../src/agents/agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "../src/agents/conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "../src/agents/embedded-agent-runner/effective-tool-policy.js";
import { testing as resolverTesting } from "../src/agents/mcp-connection-resolver.js";
import { resolveChannelGroupPolicy } from "../src/config/group-policy.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { TelegramAccountConfig } from "../src/config/types.telegram.js";

const SERVER_NAME = "google_workspace";
const PRIVATE_PROBE = `${SERVER_NAME}__google_private_gmail_search`;
const ARTIFACT_PROBE = `${SERVER_NAME}__google_artifact_get`;
const MCP_URL = "http://127.0.0.1:18080/google/mcp";
const ADMISSION_URL = "http://127.0.0.1:18080/test/admission";

type ResolverContext = {
  agentId?: string;
  sessionKey?: string;
  chatType?: string;
  conversationId?: string;
  requesterSenderId?: string;
  traceId?: string;
};

type ProductionResolver = {
  serverName: string;
  requiresRequesterIdentity: false;
  resolve(context: ResolverContext): Promise<{
    url: string;
    headers: Record<string, string>;
  }>;
};

type ResolverModule = {
  createGoogleWorkspaceResolver(
    fetchImplementation?: typeof fetch,
    admissionImplementation?: (context: ResolverContext) => Promise<string>,
  ): ProductionResolver;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the composed Google Workspace test`);
  }
  return value;
}

function resultContainsText(result: unknown, expected: string): boolean {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return false;
  }
  const content = (result as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.some(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        "text" in item &&
        typeof item.text === "string" &&
        item.text.includes(expected),
    )
  );
}

function parseGroupAllow(): string[] {
  const parsed: unknown = JSON.parse(requiredEnvironment("ARXI_GOOGLE_COMPOSED_GROUP_ALLOW"));
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("ARXI_GOOGLE_COMPOSED_GROUP_ALLOW is invalid");
  }
  return parsed;
}

async function productionResolver(): Promise<ProductionResolver> {
  const opsRoot = requiredEnvironment("ARXI_OPS_ROOT");
  const moduleURL = pathToFileURL(join(opsRoot, "guest/arxi-channel/google-workspace.mjs")).href;
  const module = (await import(/* @vite-ignore */ moduleURL)) as ResolverModule;
  return module.createGoogleWorkspaceResolver(globalThis.fetch, async (context) => {
    const response = await fetch(ADMISSION_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(context),
    });
    const value = (await response.json()) as { admissionProof?: unknown };
    if (!response.ok || typeof value.admissionProof !== "string") {
      throw new Error("test admission service refused the production resolver context");
    }
    return value.admissionProof;
  });
}

function runtimeConfig(groupAgentId: string, groupAllow: string[]): OpenClawConfig {
  return {
    agents: { entries: { [groupAgentId]: { tools: { allow: groupAllow } } } },
    mcp: {
      servers: {
        [SERVER_NAME]: { transport: "streamable-http", url: MCP_URL },
      },
    },
    channels: {
      telegram: {
        dmPolicy: "allowlist",
        allowFrom: ["42"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["42"],
        groups: { "-1001": { allowFrom: ["42"] } },
      },
    },
  };
}

async function assertTelegramAdmission(config: OpenClawConfig): Promise<void> {
  const telegram = config.channels?.telegram as TelegramAccountConfig;
  await expect(
    isTelegramDmAccessAllowed({
      dmPolicy: "allowlist",
      msg: { from: { id: 42, is_bot: false, first_name: "Owner" } } as Message,
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom(["42"]),
      accountId: "default",
    }),
  ).resolves.toBe(true);

  const groupConfig = telegram.groups?.["-1001"];
  const groupAllow = normalizeAllowFrom(groupConfig?.allowFrom);
  expect(
    evaluateTelegramGroupBaseAccess({
      isGroup: true,
      groupConfig,
      hasGroupAllowOverride: true,
      effectiveGroupAllow: groupAllow,
      senderId: "42",
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    }),
  ).toEqual({ allowed: true });
  expect(
    evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-1001",
      cfg: config,
      telegramCfg: telegram,
      groupConfig,
      effectiveGroupAllow: groupAllow,
      senderId: "42",
      resolveGroupPolicy: (chatId, cfg) =>
        resolveChannelGroupPolicy({ cfg, channel: "telegram", groupId: String(chatId) }),
      enforcePolicy: true,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    }),
  ).toMatchObject({ allowed: true });
}

async function visibleTools(params: {
  runtime: SessionMcpRuntime;
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  chatType: "direct" | "group";
}) {
  const materialized = await materializeBundleMcpToolsForRun({ runtime: params.runtime });
  return applyFinalEffectiveToolPolicy({
    bundledTools: materialized.tools,
    config: params.config,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      messageProvider: "telegram",
      messageChannel: "telegram",
      chatType: params.chatType,
      senderId: "42",
    }),
    warn: () => {},
  });
}

afterEach(async () => {
  resolverTesting.setMcpServerConnectionResolversForTest();
  await disposeAllSessionMcpRuntimes();
});

const liveComposedTest = process.env.ARXI_GOOGLE_COMPOSED_LIVE === "1" ? it : it.skip;

describe("authenticated Telegram to Arxi Google Workspace composition", () => {
  liveComposedTest(
    "uses the production resolver, real MCP runtime, Arxi policy, and real facade boundary",
    async () => {
      const identityId = requiredEnvironment("ARXI_GOOGLE_COMPOSED_IDENTITY_ID");
      const groupAgentId = requiredEnvironment("ARXI_GOOGLE_COMPOSED_GROUP_AGENT_ID");
      const groupAllow = parseGroupAllow();
      const config = runtimeConfig(groupAgentId, groupAllow);
      await assertTelegramAdmission(config);

      const resolver = await productionResolver();
      expect(resolver.serverName).toBe(SERVER_NAME);
      resolverTesting.setMcpServerConnectionResolversForTest([resolver]);

      const privateSessionKey = `agent:${identityId}:telegram:private:42`;
      const privateRuntime = await getOrCreateSessionMcpRuntime({
        sessionId: "google-composed-private",
        sessionKey: privateSessionKey,
        workspaceDir: process.cwd(),
        cfg: config,
        requesterSenderId: "telegram:42",
        agentAccountId: "default",
        messageChannel: "telegram",
        agentId: identityId,
        chatType: "private",
        conversationId: `telegram-private:${identityId}:42`,
        runtimeGeneration: "12",
        traceId: "11111111111111111111111111111111",
      });
      const privateTools = await visibleTools({
        runtime: privateRuntime,
        config,
        agentId: identityId,
        sessionKey: privateSessionKey,
        chatType: "direct",
      });
      expect(privateTools.some((tool) => tool.name === PRIVATE_PROBE)).toBe(true);
      const privateProbe = privateTools.find((tool) => tool.name === PRIVATE_PROBE);
      const privateResult = await privateProbe?.execute?.("private-probe", {
        query: "newer_than:1d",
      });
      expect(resultContainsText(privateResult, "owner@gmail.test")).toBe(true);

      const groupSessionKey = `agent:${groupAgentId}:dashboard:incognito-0123456789abcdef0123456789abcdef`;
      const groupRuntime = await getOrCreateSessionMcpRuntime({
        sessionId: "google-composed-group",
        sessionKey: groupSessionKey,
        workspaceDir: process.cwd(),
        cfg: config,
        requesterSenderId: "telegram:42",
        agentAccountId: "default",
        messageChannel: "telegram",
        agentId: groupAgentId,
        chatType: "group",
        conversationId: `telegram-group:${identityId}:gpr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:topic:7`,
        runtimeGeneration: "12",
        traceId: "22222222222222222222222222222222",
      });
      const groupTools = await visibleTools({
        runtime: groupRuntime,
        config,
        agentId: groupAgentId,
        sessionKey: groupSessionKey,
        chatType: "group",
      });
      expect(groupTools.map((tool) => tool.name).toSorted()).toEqual(groupAllow.toSorted());
      expect(groupTools.some((tool) => tool.name.includes("__google_private_"))).toBe(false);
      const artifactProbe = groupTools.find((tool) => tool.name === ARTIFACT_PROBE);
      const artifactResult = await artifactProbe?.execute?.("artifact-probe", {
        resourceId: "doc-1",
      });
      expect(resultContainsText(artifactResult, "arxi-41@artifact.test")).toBe(true);
    },
    60_000,
  );
});
