import { createHash } from "node:crypto";
import { responsesProviderRequestGate } from "@openclaw/ai/internal/openai";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithPersonalPromptProviderGate } from "./personal-prompt-provider-stream.js";
import type { StreamFn } from "./runtime/index.js";

const segmentText = "## USER.md\nKeep owner limits.";
const packetText = 'Personal context: {"status":"ready"}';
const model = { id: "gpt-6-sol", api: "openai-responses" } as Parameters<StreamFn>[0];
const context = { messages: [] } as Parameters<StreamFn>[1];

function makeGate(
  params: {
    full?: number;
    baseline?: number;
    packet?: string;
    counter?: boolean;
    native?: boolean;
    compacting?: boolean;
  } = {},
) {
  const sent = vi.fn();
  const provider = vi.fn(async (_model, _context, options) => {
    const payload = {
      model: "gpt-6-sol",
      instructions: `System\n${segmentText}`,
      input: [
        {
          role: "user" as const,
          content: [{ type: "input_text" as const, text: params.packet ?? packetText }],
        },
      ],
      stream: true as const,
    };
    const next = await options?.onPayload?.(payload, model);
    const finalRequest = (next ?? payload) as typeof payload;
    await responsesProviderRequestGate.get(options)?.(finalRequest);
    sent(finalRequest);
    return {} as Awaited<ReturnType<StreamFn>>;
  }) as StreamFn;
  const receipts: unknown[] = [];
  const counter = vi.fn(async (body: Record<string, unknown>) =>
    JSON.stringify(body).includes("Personal context:")
      ? (params.full ?? 70)
      : (params.baseline ?? 20),
  );
  const stream = wrapStreamFnWithPersonalPromptProviderGate({
    streamFn: provider,
    personalPrompt: {
      legacySegments: [
        {
          name: "USER.md",
          path: "USER.md",
          text: segmentText,
          sha256: createHash("sha256").update(segmentText).digest("hex"),
          mandatory: true,
        },
      ],
      ...(params.counter === false ? {} : { countResponseInputTokens: counter }),
      readPreparedPacket: () => ({ text: packetText, budgetTokens: 8_000 }),
      recordProviderReceipt: (receipt) => receipts.push(receipt),
    },
    isCompacting: () => params.compacting === true,
    nativePreEgress: params.native !== false,
  });
  return { stream, sent, receipts, counter };
}

describe("provider-bound personal prompt stream gate", () => {
  it("records one selected-model receipt before provider send", async () => {
    const gate = makeGate();
    await gate.stream(model, context);
    expect(gate.sent).toHaveBeenCalledOnce();
    expect(gate.receipts).toMatchObject([{ personalTokens: 50, status: "within_budget" }]);
    expect(gate.counter).toHaveBeenCalledTimes(2);
  });

  it("blocks oversized, duplicate, and unavailable counts before provider send", async () => {
    const oversized = makeGate({ full: 9_200, baseline: 100 });
    await expect(oversized.stream(model, context)).rejects.toThrow("needs_expansion");
    expect(oversized.sent).not.toHaveBeenCalled();

    const duplicate = makeGate({ packet: `${packetText}\n${packetText}` });
    await expect(duplicate.stream(model, context)).rejects.toThrow("packet missing or duplicated");
    expect(duplicate.sent).not.toHaveBeenCalled();

    const unsupported = makeGate({ counter: false });
    const blocked = await unsupported.stream(model, context);
    expect(await blocked.result()).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("tokenizer unavailable"),
    });
    expect(unsupported.sent).not.toHaveBeenCalled();

    const customTransport = makeGate({ native: false });
    const customResult = await customTransport.stream(model, context);
    expect(await customResult.result()).toMatchObject({ stopReason: "error" });
    expect(customTransport.sent).not.toHaveBeenCalled();

    const compacting = makeGate({ compacting: true });
    const compactingResult = await compacting.stream(model, context);
    expect(await compactingResult.result()).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("compaction requires revalidation"),
    });
    expect(compacting.sent).not.toHaveBeenCalled();
  });

  it("checks the payload after a later onPayload override", async () => {
    const gate = makeGate();
    await expect(
      gate.stream(model, context, {
        onPayload: (body) => ({
          ...(body as Record<string, unknown>),
          input: [{ role: "user", content: [{ type: "input_text", text: "packet removed" }] }],
        }),
      }),
    ).rejects.toThrow("packet missing or duplicated");
    expect(gate.sent).not.toHaveBeenCalled();
    expect(gate.counter).not.toHaveBeenCalled();
  });
});
