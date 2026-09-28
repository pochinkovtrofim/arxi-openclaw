import { describe, expect, it } from "vitest";
import { CodexInferenceNeedsExpansionError } from "./inference-context.js";
import { createCodexPersonalPreEgressGate } from "./personal-context-gate.js";
import type { JsonObject } from "./protocol.js";

const packet = '[Pati packet] {"source":"owner_sources"}';
const prompt = `Pati context:\n${packet}\n\nUser: remind me tomorrow`;
const legacy = "## USER.md\nOwner prefers concise answers.";
const developer = "Owner source guidance and private scope.";

function initial(): JsonObject {
  return {
    model: "gpt-6-sol",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: developer }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call_output", call_id: "old-history", output: "old session history" },
    ],
    instructions: `native instructions\n\n${legacy}`,
  };
}

describe("Codex OAuth personal pre-egress gate", () => {
  it("charges actual final prompt leaves and cumulative new native tool outputs once", () => {
    const receipts: number[] = [];
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      onReceipt: (receipt) => receipts.push(receipt.upperBoundUtf8Bytes),
    });
    gate(initial());
    const first = receipts.at(-1)!;
    expect(first).toBeGreaterThan(Buffer.byteLength(prompt + legacy + developer));
    const tool = {
      type: "function_call_output",
      call_id: "new-read",
      output: "memory_get excerpt",
    };
    gate({ ...initial(), input: [...(initial().input as JsonObject[]), tool] });
    expect(receipts.at(-1)).toBe(first + Buffer.byteLength(JSON.stringify(tool)));
    gate({ ...initial(), input: [...(initial().input as JsonObject[]), tool] });
    expect(receipts.at(-1)).toBe(receipts.at(-2));
  });

  it("checks a WebSocket delta and refuses an over-budget tool result", () => {
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      budgetTokens: 8000,
    });
    gate(initial());
    expect(() =>
      gate({
        previous_response_id: "resp-1",
        input: [{ type: "function_call_output", call_id: "read-1", output: "x".repeat(8000) }],
      }),
    ).toThrow(CodexInferenceNeedsExpansionError);
  });

  it("refuses a missing, duplicated, or fitted-away packet before egress", () => {
    const config = {
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
    };
    expect(() =>
      createCodexPersonalPreEgressGate({ ...config, promptText: "fitted away" }),
    ).toThrow(CodexInferenceNeedsExpansionError);
    const missing = initial();
    missing.input = [{ type: "message", role: "user", content: "ordinary request" }];
    expect(() => createCodexPersonalPreEgressGate(config)(missing)).toThrow(
      CodexInferenceNeedsExpansionError,
    );
    const duplicate = initial();
    duplicate.input = [...(duplicate.input as JsonObject[]), { type: "message", content: packet }];
    expect(() => createCodexPersonalPreEgressGate(config)(duplicate)).toThrow(
      CodexInferenceNeedsExpansionError,
    );
  });

  it("keeps a substantial Cyrillic Owner packet available and exposes conservative headroom", () => {
    const cyrillicPacket = `Источник: ${"Пати помнит договоренность владельца. ".repeat(80)}`;
    const cyrillicPrompt = `Личный контекст:\n${cyrillicPacket}\n\nНовый вопрос`;
    let bound = 0;
    const gate = createCodexPersonalPreEgressGate({
      promptText: cyrillicPrompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: cyrillicPacket,
      onReceipt: (receipt) => {
        bound = receipt.upperBoundUtf8Bytes;
      },
    });
    gate({
      input: [
        { type: "message", content: cyrillicPrompt },
        { type: "message", content: developer },
      ],
      instructions: legacy,
    });
    expect(Buffer.byteLength(cyrillicPacket, "utf8")).toBeGreaterThan(5_000);
    expect(bound).toBeGreaterThan(Buffer.byteLength(cyrillicPacket, "utf8"));
    expect(bound).toBeLessThan(8_000);
  });

  it("combines another personal developer hook with USER, MEMORY and Pati without charging generic policy", () => {
    const genericPolicy = "generic tool instructions ".repeat(600);
    const otherHook = "Private promise from another before_prompt_build hook";
    const memory = "## MEMORY.md\nOwner's remembered preference.";
    const actualDeveloper = `${genericPolicy}\n\n${otherHook}`;
    const receipts: Array<{ upperBoundUtf8Bytes: number; sources: readonly { name: string }[] }> =
      [];
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: actualDeveloper,
      developerBaseInstructions: genericPolicy,
      legacySegments: [
        { name: "USER.md", text: legacy },
        { name: "MEMORY.md", text: memory },
      ],
      packetText: packet,
      onReceipt: (receipt) => receipts.push(receipt),
    });
    gate({
      input: [
        { type: "message", role: "developer", content: actualDeveloper },
        { type: "message", role: "user", content: prompt },
      ],
      instructions: `${legacy}\n\n${memory}`,
    });
    expect(Buffer.byteLength(genericPolicy)).toBeGreaterThan(8_000);
    expect(receipts[0]?.upperBoundUtf8Bytes).toBeLessThan(8_000);
    expect(receipts[0]?.sources.map((source) => source.name)).toEqual([
      "USER.md",
      "MEMORY.md",
      "turn_prompt",
      "hook_developer",
    ]);
  });

  it("does not charge a separately identified long current user message to personal memory", () => {
    const user = "ordinary current turn ".repeat(600);
    const finalPrompt = `${packet}\n\n${user}`;
    let bound = 0;
    const gate = createCodexPersonalPreEgressGate({
      promptText: finalPrompt,
      currentUserMessage: user,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      onReceipt: (receipt) => {
        bound = receipt.upperBoundUtf8Bytes;
      },
    });
    gate({
      input: [
        { type: "message", content: finalPrompt },
        { type: "message", content: developer },
      ],
      instructions: legacy,
    });
    expect(Buffer.byteLength(user)).toBeGreaterThan(8_000);
    expect(bound).toBeLessThan(8_000);
  });
});
