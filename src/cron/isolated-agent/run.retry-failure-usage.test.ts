import { describe, expect, it } from "vitest";
import type { NormalizedUsage } from "../../agents/usage.js";
import type { SessionEntry } from "../../config/sessions.js";
import { onInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  deriveSessionTotalTokensMock,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("cron retry failure accounting", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each(["cancellation", "session-replaced", "delivery-failure"] as const)(
    "keeps completed usage once after retry %s without delivering the acknowledgement",
    async (outcome) => {
      const cronSession = makeCronSession();
      const sessionScope = {
        storePath: cronSession.storePath,
        sessionKey: "agent:main:cron:test",
      };
      resolveCronSessionMock.mockReturnValue(cronSession);
      pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
        (payloads: Array<{ text?: string }>) => payloads.at(-1)?.text ?? "",
      );
      resolveCronDeliveryPlanMock.mockReturnValue({
        requested: true,
        mode: "announce",
        channel: "messagechat",
        to: "123",
      });
      const controller = new AbortController();
      const retryCompleted = outcome === "delivery-failure";
      const error =
        outcome === "cancellation"
          ? "cron: job execution timed out"
          : retryCompleted
            ? "delivery failed"
            : "retry failed";
      if (retryCompleted) {
        dispatchCronDeliveryMock.mockRejectedValueOnce(new Error(error));
      }
      runEmbeddedAgentMock
        .mockImplementationOnce(async (request) => {
          request.onExecutionStarted?.();
          return {
            payloads: [{ text: "On it, checking the report now." }],
            meta: {
              agentMeta: {
                provider: "completed-provider",
                model: "completed-model",
                sessionId: "ack-session",
                agentHarnessId: "ack-harness",
                contextTokens: 2000,
                usage: { input: 10, output: 20, cacheRead: 3, cost: { total: 0.01 } },
                diagnosticUsage: { input: 100, output: 200, cost: { total: 0.05 } },
                lastCallUsage: { input: 8, output: 2 },
              },
            },
          };
        })
        .mockImplementationOnce(async () => {
          if (retryCompleted) {
            return {
              payloads: [{ text: "The report is ready." }],
              meta: { agentMeta: { usage: { input: 30, output: 40, cost: { total: 0.02 } } } },
            };
          }
          if (outcome === "cancellation") {
            controller.abort(new Error(error));
          }
          if (outcome === "session-replaced") {
            await patchSessionEntryMock(
              sessionScope,
              (entry: SessionEntry) => ({
                ...entry,
                sessionId: "replacement-session",
                lifecycleRevision: "replacement-revision",
                inputTokens: 999,
                estimatedCostUsd: 9,
              }),
              { fallbackEntry: cronSession.sessionEntry },
            );
          }
          throw new Error(error);
        });
      mockRunCronFallbackPassthrough();
      const usageEvents: unknown[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "model.usage") {
          usageEvents.push(event);
        }
      });
      try {
        const result = await runCronIsolatedAgentTurn(
          makeIsolatedAgentParamsFixture({ agentId: "main", abortSignal: controller.signal }),
        );

        expect(result).toMatchObject({ status: "error", error, executionStarted: true });
        expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
        expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(retryCompleted ? 1 : 0);
        if (retryCompleted) {
          expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
            expect.objectContaining({ deliveryPayloads: [{ text: "The report is ready." }] }),
          );
        }
        expect(result.outputText).toBeUndefined();
        // The first prompt's terminal cumulative usage, not its last call, is what it cost.
        expect(result.usage).toEqual({
          input_tokens: retryCompleted ? 130 : 100,
          output_tokens: retryCompleted ? 240 : 200,
          total_tokens: retryCompleted ? 370 : 300,
        });
        expect(cronSession.sessionEntry).toMatchObject({
          inputTokens: retryCompleted ? 130 : 100,
          outputTokens: retryCompleted ? 240 : 200,
          cacheRead: 0,
          cacheWrite: 0,
          estimatedCostUsd: retryCompleted ? 0.07 : 0.05,
        });
        expect(cronSession.sessionEntry.sessionId).toBe("test-session-id");
        expect(cronSession.sessionEntry.agentHarnessId).not.toBe("ack-harness");
        if (outcome === "session-replaced") {
          expect(await patchSessionEntryMock(sessionScope, () => null)).toMatchObject({
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-revision",
            inputTokens: 999,
            estimatedCostUsd: 9,
          });
          expect(logWarnMock).toHaveBeenCalledWith(
            expect.stringContaining(`Session "${sessionScope.sessionKey}" changed`),
          );
        }
        expect(usageEvents).toMatchObject([
          {
            provider: "completed-provider",
            model: "completed-model",
            usage: { input: 100, output: 200, total: 300 },
            context: { limit: 2000, used: 8 },
            costUsd: 0.05,
          },
          ...(retryCompleted
            ? [{ usage: { input: 30, output: 40, total: 70 }, costUsd: 0.02 }]
            : []),
        ]);
      } finally {
        unsubscribe();
      }
    },
  );
});

async function runUsageCase(
  usage: NormalizedUsage,
  lastCallUsage: NormalizedUsage,
  totalTokens?: number,
  diagnosticUsage?: NormalizedUsage,
) {
  const cronSession = makeCronSession();
  resolveCronSessionMock.mockReturnValue(cronSession);
  mockRunCronFallbackPassthrough();
  deriveSessionTotalTokensMock.mockReturnValueOnce(totalTokens);
  runEmbeddedAgentMock.mockResolvedValueOnce({
    payloads: [{ text: "done" }],
    meta: { agentMeta: { usage, lastCallUsage, ...(diagnosticUsage ? { diagnosticUsage } : {}) } },
  });
  const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
  expect(result.status).toBe("ok");
  return { result, cronSession };
}

describe("runCronIsolatedAgentTurn usage accounting", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("uses final-call usage for the stored session token snapshot", async () => {
    const { result, cronSession } = await runUsageCase(
      { input: 75000, output: 2000, total: 56000, cacheRead: 5000, cacheWrite: 0 },
      { input: 55000, output: 1000, cacheRead: 1000, cacheWrite: 0 },
      56000,
    );
    expect(cronSession.sessionEntry.inputTokens).toBe(75000);
    expect(cronSession.sessionEntry.outputTokens).toBe(2000);
    expect(cronSession.sessionEntry.totalTokens).toBe(56000);
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(true);
    expect(result.usage).toEqual({
      input_tokens: 75000,
      output_tokens: 2000,
      total_tokens: 82000,
      cache_read_tokens: 5000,
    });
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledWith({
      usage: {
        input: 55000,
        output: 1000,
        cacheRead: 1000,
        cacheWrite: 0,
      },
      contextTokens: 128000,
      promptTokens: undefined,
    });
  });

  it("does not fall back to aggregate billing when final-call context is unavailable", async () => {
    const usage = {
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
    };
    const { result, cronSession } = await runUsageCase(usage, {
      ...usage,
      contextUsage: { state: "unavailable" },
    });
    expect(cronSession.sessionEntry.totalTokens).toBeUndefined();
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(false);
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({
      input_tokens: 12,
      output_tokens: 15_104,
      total_tokens: 927_907,
      cache_read_tokens: 819_661,
      cache_write_tokens: 93_130,
    });
  });

  it("records every model call of a CLI prompt, not only its last call", async () => {
    const lastCall = { input: 2, output: 300, cacheRead: 150_000, cacheWrite: 1_000 };
    const { result, cronSession } = await runUsageCase(
      lastCall,
      lastCall,
      151_302,
      { input: 40, output: 9_000, cacheRead: 1_900_000, cacheWrite: 60_000 },
    );
    expect(result.usage).toEqual({
      input_tokens: 40,
      output_tokens: 9_000,
      total_tokens: 1_969_040,
      cache_read_tokens: 1_900_000,
      cache_write_tokens: 60_000,
    });
    expect(cronSession.sessionEntry).toMatchObject({
      inputTokens: 40,
      outputTokens: 9_000,
      cacheRead: 1_900_000,
      cacheWrite: 60_000,
      totalTokens: 151_302,
    });
  });
});
