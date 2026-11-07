// Imported by agent.test.ts to share its existing Gateway fixture and module graph.
import { afterEach, describe, expect, it } from "vitest";
import {
  backendGatewayClient,
  describe0AfterEach0,
  getAgentTestMocks,
  invokeAgent,
  mockMainSessionEntry,
  mockSuccessfulAgentCommand,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent redelivery of a restart-recovered turn", () => {
  afterEach(describe0AfterEach0);

  const redeliver = async (runId: string) =>
    await invokeAgent(
      {
        message: "what is the weather this weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { client: backendGatewayClient() },
    );

  it.each([
    {
      name: "recovery is still answering it",
      recovery: {
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "external:interrupted",
      },
    },
    {
      name: "recovery already answered it",
      recovery: { restartRecoveryTerminalRunIds: ["external:interrupted"] },
    },
  ])("answers it as done without a second run when $name", async ({ recovery }) => {
    mockMainSessionEntry({ sessionId: "main-session", updatedAt: Date.now(), ...recovery });
    mockSuccessfulAgentCommand();
    mocks.agentCommand.mockClear();

    const respond = await redeliver("external:interrupted");

    expect(respond).toHaveBeenCalledWith(
      true,
      { runId: "external:interrupted", status: "ok" },
      undefined,
      expect.objectContaining({ runId: "external:interrupted" }),
    );
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("still runs another message in a session that recovery is answering", async () => {
    mockMainSessionEntry({
      sessionId: "main-session",
      updatedAt: Date.now(),
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "external:interrupted",
    });
    mockSuccessfulAgentCommand();
    mocks.agentCommand.mockClear();

    await redeliver("external:next-message");

    expect(mocks.agentCommand).toHaveBeenCalledOnce();
  });
});
