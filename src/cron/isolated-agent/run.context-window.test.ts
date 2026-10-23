// A persistent cron session's selected context window bounds its embedded run.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn context window", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "messagechat",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it.each([
    ["200k", "200k"],
    [undefined, undefined],
  ])("passes the session's selected window %s to the embedded run", async (selected, expected) => {
    mockRunCronFallbackPassthrough();
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        isNewSession: false,
        sessionEntry: makeCronSessionEntry(selected ? { contextWindow: selected } : {}),
      }),
    );
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: { agentMeta: {} },
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: { agents: { entries: { main: {} } }, session: { scope: "global" } },
        agentId: "main",
        sessionKey: "main",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "session:main",
          delivery: { mode: "none" },
        }),
      }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]?.contextWindow).toBe(expected);
  });
});
