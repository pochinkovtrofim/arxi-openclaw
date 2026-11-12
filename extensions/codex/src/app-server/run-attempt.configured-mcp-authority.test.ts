import "./run-attempt.configured-mcp.test-support.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createCronAuthorityCapabilityFixture } from "./codex-app-server.test-fixtures.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
} from "./run-attempt-test-harness.js";

const { admitLocalOperatorCronAuthority, configureFakeMcp, mcpMocks, setupConfiguredMcpTestHooks } =
  await import("./run-attempt.configured-mcp.test-support.js");

setupConfiguredMcpTestHooks();

describe("runCodexAppServerAttempt configured MCP creator authority", () => {
  function createMcpAuthorityParams(senderIsOwner?: boolean) {
    const params = createTestParams();
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = senderIsOwner;
    return params;
  }

  async function startMcpAttempt(params: ReturnType<typeof createMcpAuthorityParams>) {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    return {
      harness,
      finish: async () => {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await expect(run).resolves.toBeDefined();
      },
    };
  }

  it("withholds final provenance when a sender-attributed turn cannot snapshot native MCP", async () => {
    const params = createMcpAuthorityParams(true);
    params.senderId = "external-sender";

    const { finish } = await startMcpAttempt(params);
    await finish();

    expect(mcpMocks.authorityResolvers).toHaveLength(0);
    expect(mcpMocks.captureRefs).toHaveLength(1);
    expect(mcpMocks.captureRefs[0]!.value).toBeUndefined();
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
  });

  it.each([
    { name: "wrong-run", capabilityRunId: "other-run" },
    { name: "channel-owner-management", capabilityRunId: "same-run" },
  ])(
    "does not bind $name local-operator authority at Codex tool construction",
    async (testCase) => {
      const params = createMcpAuthorityParams(false);
      const capability = createCronAuthorityCapabilityFixture(
        testCase.capabilityRunId === "same-run" ? params.runId : testCase.capabilityRunId,
      );
      params.cronCreatorAuthorityCapability =
        testCase.capabilityRunId === "same-run"
          ? {
              ...capability,
              callerOrigin: { kind: "unknown" },
              managementEntitlement: { source: "channel-owner", isCurrent: () => true },
            }
          : capability;

      const { finish } = await startMcpAttempt(params);
      await finish();

      expect(mcpMocks.authorityResolvers).toHaveLength(0);
    },
  );

  it("preserves advertised configured MCP names when capturing automation authority", async () => {
    const params = createMcpAuthorityParams();
    params.config!.mcp!.servers!.fake!.codex = { defaultToolsApprovalMode: "approve" };
    params.toolsAllow = ["automations", "fake__*"];
    admitLocalOperatorCronAuthority(params);
    mcpMocks.useRealStaticMcp = true;

    const { harness, finish } = await startMcpAttempt(params);
    try {
      const threadStart = harness.requests.find((request) => request.method === "thread/start")
        ?.params as { dynamicTools?: CodexDynamicToolSpec[] } | undefined;
      const advertisedMcpNames = flattenCodexDynamicToolFunctions(threadStart?.dynamicTools)
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("fake__"))
        .toSorted();
      expect(advertisedMcpNames).toContain("fake__show");

      const authority = await mcpMocks.authorityResolvers[0]!();
      const inheritedMcpNames = authority.tools
        .map((tool) => (typeof tool === "string" ? tool : tool.name))
        .filter((name) => name.startsWith("fake__"))
        .toSorted();
      expect(inheritedMcpNames).toEqual(advertisedMcpNames);
    } finally {
      await finish();
    }
  });

  it("offers explicit finite tools when inherited configured MCP discovery is incomplete", async () => {
    const params = createMcpAuthorityParams(true);
    admitLocalOperatorCronAuthority(params);
    mcpMocks.staticDiagnosticNotice =
      "Configured MCP is incomplete for this scheduled run: fake: authentication required.";

    const { finish } = await startMcpAttempt(params);

    await expect(mcpMocks.authorityResolvers[0]!()).rejects.toThrow(
      "provide an explicit finite toolsAllow list containing only currently visible tools",
    );
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await finish();
  });

  it("rematerializes after one cron operation aborts pending materialization", async () => {
    const params = createMcpAuthorityParams(true);
    admitLocalOperatorCronAuthority(params);

    const { finish } = await startMcpAttempt(params);
    const resolver = mcpMocks.authorityResolvers[0]!;
    const firstOperation = new AbortController();
    const firstResolution = resolver({ signal: firstOperation.signal });
    firstOperation.abort(new Error("first cron call timed out"));

    await expect(firstResolution).rejects.toThrow("first cron call timed out");
    const secondResolution = await resolver({ signal: new AbortController().signal });

    expect(
      secondResolution.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("fake__show");
    expect(
      secondResolution.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).not.toContain("fake__app_only");
    expect(mcpMocks.staticCalls).toHaveLength(2);
    expect(mcpMocks.dispose).toHaveBeenCalledTimes(2);

    await finish();
  });

  it("retains an unrelated cached timeout when its operation signal aborts concurrently", async () => {
    const params = createMcpAuthorityParams(true);
    admitLocalOperatorCronAuthority(params);
    const failureGate = createDeferred<void>();
    mcpMocks.staticFailureGate = failureGate.promise;
    mcpMocks.staticFailure = Object.assign(new Error("configured MCP materialization timed out"), {
      name: "TimeoutError",
    });

    const { finish } = await startMcpAttempt(params);
    const resolver = mcpMocks.authorityResolvers[0]!;
    const operation = new AbortController();
    const firstResolution = resolver({ signal: operation.signal });
    operation.abort(new Error("cron tool call was cancelled"));
    failureGate.resolve();

    await expect(firstResolution).rejects.toThrow(
      "provide an explicit finite toolsAllow list containing only currently visible tools",
    );
    const secondResolution = resolver({ signal: new AbortController().signal });
    expect(secondResolution).toBe(firstResolution);
    await expect(secondResolution).rejects.toThrow("configured MCP materialization timed out");
    expect(mcpMocks.staticCalls).toHaveLength(1);

    await finish();
  });
});
