import { createHash } from "node:crypto";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithPersonalPromptProviderGate } from "./personal-prompt-provider-stream.js";

const sdk = vi.hoisted(() => ({ requests: [] as Array<Record<string, unknown>> }));
vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: (request: Record<string, unknown>) => {
        sdk.requests.push(request);
        return {
          withResponse: async () => {
            throw new Error("stop after dispatch");
          },
        };
      },
    };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

const source = "## USER.md\nKeep owner limits.";
const packet = 'Personal context: {"status":"ready"}';
const model = {
  id: "gpt-6-sol",
  name: "GPT-6 Sol",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} as Parameters<ReturnType<typeof createOpenAIResponsesTransportStreamFn>>[0];

function run(onPayload?: (body: Record<string, unknown>) => Record<string, unknown>, full = 70) {
  sdk.requests = [];
  const receipts: Array<Record<string, unknown>> = [];
  const countResponseInputTokens = vi.fn(async (request: Record<string, unknown>) =>
    JSON.stringify(request).includes("Personal context:") ? full : 20,
  );
  const guarded = wrapStreamFnWithPersonalPromptProviderGate({
    streamFn: createOpenAIResponsesTransportStreamFn(),
    personalPrompt: {
      legacySegments: [
        {
          name: "USER.md",
          path: "USER.md",
          text: source,
          sha256: createHash("sha256").update(source).digest("hex"),
          mandatory: true,
        },
      ],
      countResponseInputTokens,
      readPreparedPacket: () => ({ text: packet, budgetTokens: 8_000 }),
      recordProviderReceipt: (receipt) => receipts.push(receipt),
    },
    isCompacting: () => false,
    nativePreEgress: true,
  });
  const context = {
    systemPrompt: `System\n${source}`,
    messages: [{ role: "user", content: packet, timestamp: 1 }],
    tools: [],
  } as Parameters<typeof guarded>[1];
  const stream = guarded(model, context, {
    apiKey: "test-key",
    transport: "websocket",
    ...(onPayload ? { onPayload: (body) => onPayload(body as Record<string, unknown>) } : {}),
  } as Parameters<typeof guarded>[2]);
  return { stream, receipts, countResponseInputTokens };
}

describe("native final Responses personal context gate", () => {
  it("checks the sanitized provider attempt, counts combined source, and records a receipt", async () => {
    const test = run((body) => ({ ...body, metadata: { later: "override" } }));
    await (await test.stream).result();
    expect(sdk.requests).toHaveLength(1);
    expect(sdk.requests[0]?.store).toBe(false);
    expect(sdk.requests[0]?.metadata).toMatchObject({ later: "override" });
    expect(test.receipts).toMatchObject([
      { model: "gpt-6-sol", personalTokens: 50, status: "within_budget" },
    ]);
    expect(test.countResponseInputTokens).toHaveBeenCalledTimes(2);
  });

  it("blocks oversized mandatory context and late duplicate before SDK dispatch", async () => {
    const oversized = run(undefined, 9_200);
    const oversizedResult = await (await oversized.stream).result();
    expect(oversizedResult.errorMessage).toContain("needs_expansion");
    expect(sdk.requests).toHaveLength(0);

    const duplicate = run((body) => ({
      ...body,
      input: [
        { role: "user", content: [{ type: "input_text", text: packet }] },
        { role: "user", content: [{ type: "input_text", text: packet }] },
      ],
    }));
    const duplicateResult = await (await duplicate.stream).result();
    expect(duplicateResult.errorMessage).toContain("packet missing or duplicated");
    expect(sdk.requests).toHaveLength(0);
    expect(duplicate.countResponseInputTokens).not.toHaveBeenCalled();
  });
});
