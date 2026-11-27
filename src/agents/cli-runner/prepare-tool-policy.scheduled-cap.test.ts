import { describe, expect, it } from "vitest";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

const MANAGED_NATIVE_TOOLS = ["Agent", "Bash", "Read", "WebSearch", "ToolSearch"];
const CAP = ["message", "web_search", "ro_life", "cron"];
const scheduledToolPolicy = {
  version: 1,
  mode: "account",
  ownerSessionKey: "agent:main:main",
  ownerAccountId: "default",
  ownerOrigin: { kind: "local" },
} as const;

const params: RunCliAgentParams = {
  sessionId: "job",
  sessionKey: "agent:main:cron:job",
  sessionFile: "fixture.jsonl",
  workspaceDir: "/workspace",
  prompt: "run the automation",
  provider: "claude-cli",
  model: "fixture",
  runId: "fixture-run",
  timeoutMs: 1000,
  config: {},
};
const input = {
  params,
  policyAgentId: "main",
  policySessionKey: params.sessionKey,
  backendId: "claude-cli",
  bundleMcp: true,
  canEnforceExactToolAvailability: true,
  resolveManagedNativeTools: () => MANAGED_NATIVE_TOOLS,
  capabilityFreeNativeTools: ["ToolSearch"],
  isSideQuestion: false,
  skipsTurnPreparation: false,
};

describe("a scheduled cap enforced at execution", () => {
  it("launches the uncapped run's surface and carries the cap for execution", async () => {
    const uncapped = await resolveCliRuntimeToolPolicy(input);
    const capped = await resolveCliRuntimeToolPolicy({
      ...input,
      params: { ...params, toolsAllow: CAP, scheduledToolPolicy },
    });

    expect(capped.params.cliToolAvailability).toEqual(uncapped.params.cliToolAvailability);
    expect(capped.params.cliToolAvailability?.native).toEqual(MANAGED_NATIVE_TOOLS);
    expect(capped.runtimeToolsAllowPolicy).toEqual(uncapped.runtimeToolsAllowPolicy);
    expect(capped.managedNativeTools).toEqual(uncapped.managedNativeTools);
    expect(capped.params.toolsAllow).toBeUndefined();
    expect(capped.params.executionToolsAllow).toEqual(CAP);
    expect(uncapped.params.executionToolsAllow).toBeUndefined();
  });

  it.each([
    ["a cap naming a shell tool", { toolsAllow: [...CAP, "exec"], scheduledToolPolicy }],
    ["a cap naming a file tool", { toolsAllow: [...CAP, "group:fs"], scheduledToolPolicy }],
    ["a cap without scheduled provenance", { toolsAllow: CAP }],
    [
      "a cap on a run with tools disabled",
      { toolsAllow: CAP, scheduledToolPolicy, disableTools: true },
    ],
  ])("keeps the exact cap for %s", async (_label, overrides) => {
    const result = await resolveCliRuntimeToolPolicy({
      ...input,
      params: { ...params, ...overrides },
    });

    expect(result.params.executionToolsAllow).toBeUndefined();
    expect(result.params.cliToolAvailability?.native).toEqual([]);
    expect(result.managedNativeTools).toEqual([]);
    if (overrides.disableTools !== true) {
      expect(result.runtimeToolsAllowPolicy).toEqual(overrides.toolsAllow);
    }
  });

  it("keeps the exact cap where the backend names no capability-free native tool", async () => {
    const result = await resolveCliRuntimeToolPolicy({
      ...input,
      capabilityFreeNativeTools: undefined,
      params: { ...params, toolsAllow: CAP, scheduledToolPolicy },
    });

    expect(result.params.executionToolsAllow).toBeUndefined();
    expect(result.params.cliToolAvailability?.native).toEqual([]);
    expect(result.runtimeToolsAllowPolicy).toEqual(CAP);
  });

  it("keeps the exact cap on a run that is not an ordinary mediated turn", async () => {
    const result = await resolveCliRuntimeToolPolicy({
      ...input,
      params: {
        ...params,
        toolsAllow: CAP,
        scheduledToolPolicy,
        config: { tools: { fs: { workspaceOnly: true } } },
      },
    });

    expect(result.params.executionToolsAllow).toBeUndefined();
    expect(result.params.cliToolAvailability?.native).toEqual([]);
    expect(result.runtimeToolsAllowPolicy).toEqual(CAP);
  });
});
