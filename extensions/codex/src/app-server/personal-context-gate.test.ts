import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodexInferenceNeedsExpansionError } from "./inference-context.js";
import {
  createCodexPersonalPreEgressGate,
  type CodexPersonalContextReceipt,
} from "./personal-context-gate.js";
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
  it("keeps full system instruction carriers separate from personal memory and rechecks incremental and full-history requests", () => {
    const systemRule =
      "### /owner/SOUL.md\n\n" +
      "Generic system instruction. ".repeat(900) +
      "Never disclose the Owner's appointment.\n\n";
    const instructionBody = `${legacy}\n\n${systemRule}`;
    const receipts: CodexPersonalContextReceipt[] = [];
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      mandatoryInstructionSegments: [{ name: "SOUL.md", text: systemRule }],
      totalContextTokenBudget: 80_000,
      onReceipt: (receipt) => {
        receipts.push(receipt);
      },
    });
    const body = { ...initial(), instructions: instructionBody };
    gate(body);
    expect(receipts[0]?.status).toBe("within_bound");
    expect(receipts[0]?.upperBoundUtf8Bytes).toBeLessThan(8000);
    expect(receipts[0]?.nativeRequestUpperBoundUtf8Bytes).toBeGreaterThan(20_000);
    expect(receipts[0]?.instructionSources).toEqual([
      { name: "SOUL.md", sha256: createHash("sha256").update(systemRule).digest("hex") },
    ]);
    for (let i = 0; i < 4; i++) {
      gate({
        previous_response_id: "native-previous",
        instructions: instructionBody,
        input: [
          { type: "function_call_output", call_id: `read-${i}`, output: "small synthetic result" },
        ],
      });
    }
    expect(receipts.at(-1)?.status).toBe("within_bound");
    expect(receipts.at(-1)?.nativeRequestScope).toBe(
      "current_serialized_request_excludes_prior_provider_cache",
    );
    gate(body); // A real full-history request revalidates exact current sources.
    expect(() => gate({ ...body, instructions: legacy })).toThrow(
      CodexInferenceNeedsExpansionError,
    );
    expect(receipts.at(-1)?.reason).toBe("mandatory_source_omitted");
  });

  it.each(["missing", "tampered", "duplicate"])(
    "refuses a %s mandatory instruction carrier on an incremental request",
    (kind) => {
      const rule = "### /owner/AGENTS.md\n\nNever publish without approval.\n\n";
      let receipt: CodexPersonalContextReceipt | undefined;
      const gate = createCodexPersonalPreEgressGate({
        promptText: prompt,
        developerInstructions: developer,
        legacySegments: [{ name: "USER.md", text: legacy }],
        packetText: packet,
        mandatoryInstructionSegments: [{ name: "AGENTS.md", text: rule }],
        totalContextTokenBudget: 80_000,
        onReceipt: (value) => {
          receipt = value;
        },
      });
      gate({ ...initial(), instructions: `${legacy}\n\n${rule}` });
      const instructions =
        kind === "missing"
          ? ""
          : kind === "tampered"
            ? rule.replace("Never", "Always")
            : rule + rule;
      expect(() =>
        gate({ previous_response_id: "native-previous", instructions, input: [] }),
      ).toThrow(CodexInferenceNeedsExpansionError);
      expect(receipt?.reason).toBe("mandatory_source_omitted");
    },
  );

  it("leaves unknown native-model context authority native while preserving exact mandatory carriers", () => {
    const rule = "### /owner/SOUL.md\n\n" + "Whole mandatory system rule. ".repeat(1000) + "\n\n";
    let receipt: CodexPersonalContextReceipt | undefined;
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      mandatoryInstructionSegments: [{ name: "SOUL.md", text: rule }],
      onReceipt: (value) => {
        receipt = value;
      },
    });
    gate({ ...initial(), instructions: `${legacy}\n\n${rule}` });
    expect(receipt?.status).toBe("within_bound");
    expect(receipt?.nativeContextBudgetAuthority).toBe("native_owned_unavailable");
    expect(receipt?.totalContextTokenBudget).toBeUndefined();
    expect(receipt?.upperBoundUtf8Bytes).toBeLessThan(8000);
    expect(() => gate({ ...initial(), instructions: legacy })).toThrow(
      CodexInferenceNeedsExpansionError,
    );
    expect(receipt?.reason).toBe("mandatory_source_omitted");
  });

  it("refuses exceeded host-native request bound while preserving the separate personal cap", () => {
    const rule = "### /owner/SOUL.md\n\n" + "Whole mandatory system rule. ".repeat(1000) + "\n\n";
    let receipt: CodexPersonalContextReceipt | undefined;
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      mandatoryInstructionSegments: [{ name: "SOUL.md", text: rule }],
      totalContextTokenBudget: 24_000,
      onReceipt: (value) => {
        receipt = value;
      },
    });
    expect(() => gate({ ...initial(), instructions: `${legacy}\n\n${rule}` })).toThrow(
      CodexInferenceNeedsExpansionError,
    );
    expect(receipt?.reason).toBe("native_request_over_bound");
    expect(receipt?.nativeContextBudgetAuthority).toBe("host_bound");
    expect(receipt?.upperBoundUtf8Bytes).toBeLessThan(8000);
  });

  it("separates proven ordinary history while charging an old personal hook archive", () => {
    const user = "Current real admitted request";
    const history = `[user]\n${"ordinary earlier conversation ".repeat(800)}\n\n`;
    const finalPrompt = `${history}${packet}\n\n${user}`;
    const config = {
      promptText: finalPrompt,
      currentUserMessage: user,
      ordinarySessionSegments: [history],
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
    };
    const body = {
      instructions: legacy,
      input: [
        { type: "message", role: "user", content: finalPrompt },
        { type: "message", role: "developer", content: developer },
      ],
    };
    let receipt: CodexPersonalContextReceipt | undefined;
    createCodexPersonalPreEgressGate({
      ...config,
      onReceipt: (value) => {
        receipt = value;
      },
    })(body);
    expect(receipt?.ordinarySessionUpperBoundUtf8Bytes).toBeGreaterThan(8000);
    expect(receipt?.upperBoundUtf8Bytes).toBe(
      Buffer.byteLength(packet + "\n\n" + developer + legacy),
    );
    const archivedHook = "Old hook inserted private corpus: ".repeat(400);
    expect(() =>
      createCodexPersonalPreEgressGate({
        ...config,
        promptText: `${finalPrompt}\n${archivedHook}`,
      })({
        ...body,
        input: [
          { type: "message", role: "user", content: `${finalPrompt}\n${archivedHook}` },
          { type: "message", role: "developer", content: developer },
        ],
      }),
    ).toThrow(CodexInferenceNeedsExpansionError);
    expect(() =>
      createCodexPersonalPreEgressGate({ ...config, ordinarySessionSegments: [packet] })(body),
    ).toThrow(CodexInferenceNeedsExpansionError);
  });
  it("verifies declared static policy separately while charging unregistered personal additions", () => {
    const staticText = "Code-owned generic source instructions. ".repeat(250);
    const ownerConstraint = "Owner must retain this private quiet preference.";
    const actualDeveloper = `${staticText}\n\n${ownerConstraint}`;
    const config = {
      promptText: prompt,
      developerInstructions: actualDeveloper,
      staticPolicies: [{ id: "test.source-policy", text: staticText }],
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
    };
    const body = {
      ...initial(),
      input: [
        { type: "message", role: "developer", content: actualDeveloper },
        { type: "message", role: "user", content: prompt },
      ],
    };
    let receipt: CodexPersonalContextReceipt | undefined;
    createCodexPersonalPreEgressGate({
      ...config,
      onReceipt: (value) => {
        receipt = value;
      },
    })(body);
    expect(receipt?.upperBoundUtf8Bytes).toBe(
      Buffer.byteLength(prompt + legacy + ownerConstraint + "\n\n"),
    );
    expect(receipt?.staticPolicyUpperBoundUtf8Bytes).toBeGreaterThan(8000);
    expect(receipt?.staticPolicies).toEqual([
      {
        id: "test.source-policy",
        sha256: createHash("sha256").update(staticText).digest("hex"),
        upperBoundUtf8Bytes: Buffer.byteLength(staticText),
      },
    ]);
    expect(() => createCodexPersonalPreEgressGate({ ...config, staticPolicies: [] })(body)).toThrow(
      CodexInferenceNeedsExpansionError,
    );
    const changed = {
      ...body,
      input: [
        {
          type: "message",
          role: "developer",
          content: actualDeveloper.replace("Code-owned", "Tampered"),
        },
        { type: "message", role: "user", content: prompt },
      ],
    };
    expect(() => createCodexPersonalPreEgressGate(config)(changed)).toThrow(
      CodexInferenceNeedsExpansionError,
    );
    const privateLarge = "Private owner preference. ".repeat(400);
    expect(() =>
      createCodexPersonalPreEgressGate({
        ...config,
        developerInstructions: `${actualDeveloper}\n${privateLarge}`,
      })({
        ...body,
        input: [
          { type: "message", role: "developer", content: `${actualDeveloper}\n${privateLarge}` },
          { type: "message", role: "user", content: prompt },
        ],
      }),
    ).toThrow(CodexInferenceNeedsExpansionError);
  });

  it("rejects static-policy declarations overlapping mandatory private content or another exemption", () => {
    const config = {
      promptText: prompt,
      developerInstructions: `${developer}\n${legacy}`,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
    };
    const body = {
      input: [
        { type: "message", role: "developer", content: `${developer}\n${legacy}` },
        { type: "message", role: "user", content: prompt },
      ],
    };
    expect(() =>
      createCodexPersonalPreEgressGate({
        ...config,
        staticPolicies: [{ id: "test.illegal", text: legacy }],
      })(body),
    ).toThrow(CodexInferenceNeedsExpansionError);
    expect(() =>
      createCodexPersonalPreEgressGate({
        ...config,
        staticPolicies: [
          { id: "test.policy", text: developer },
          { id: "test.overlap", text: "Owner source" },
        ],
      })(body),
    ).toThrow(CodexInferenceNeedsExpansionError);
  });
  it("binds content-free receipts to every final request, including a refused continuation", () => {
    const receipts: CodexPersonalContextReceipt[] = [];
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      expectedModel: "gpt-6-sol",
      onReceipt: (receipt) => receipts.push(receipt),
    });
    const first = initial();
    gate(first);
    expect(receipts[0]).toMatchObject({
      model: "gpt-6-sol",
      exactPersonalTokens: null,
      accounting: "conservative_utf8_upper_bound",
      status: "within_bound",
      requestSequence: 1,
      requestSha256: createHash("sha256").update(JSON.stringify(first)).digest("hex"),
    });
    const delta = {
      previous_response_id: "resp-1",
      input: [
        { type: "function_call_output", call_id: "read-1", output: "private source ".repeat(700) },
      ],
    };
    expect(() => gate(delta)).toThrow(CodexInferenceNeedsExpansionError);
    expect(receipts[1]).toMatchObject({
      requestSequence: 2,
      status: "needs_expansion",
      reason: "personal_context_over_bound",
      cumulativeToolOutputs: 1,
      requestSha256: createHash("sha256").update(JSON.stringify(delta)).digest("hex"),
    });
    expect(JSON.stringify(receipts)).not.toContain("private source");
    expect(JSON.stringify(receipts)).not.toContain("Owner prefers");
  });

  it("rechecks growing full-history source wrappers after the first request", () => {
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
    });
    gate(initial());
    const growing = initial();
    growing.input = [
      ...(growing.input as JsonObject[]),
      { type: "message", role: "developer", content: `${developer}\n${"x".repeat(8000)}` },
    ];
    growing.input = (growing.input as JsonObject[]).slice(1);
    expect(() => gate(growing)).toThrow(CodexInferenceNeedsExpansionError);
  });

  it("fences the selected model in both initial and delta requests", () => {
    const config = {
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      expectedModel: "gpt-6-sol",
    };
    expect(() =>
      createCodexPersonalPreEgressGate(config)({ ...initial(), model: "other-model" }),
    ).toThrow(CodexInferenceNeedsExpansionError);
    const gate = createCodexPersonalPreEgressGate(config);
    gate(initial());
    expect(() => gate({ model: "other-model", previous_response_id: "resp-1", input: [] })).toThrow(
      CodexInferenceNeedsExpansionError,
    );
  });

  it("refuses an omitted mandatory owner source before a provider request", () => {
    let receipt: CodexPersonalContextReceipt | undefined;
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [],
      packetText: packet,
      mandatorySourcesComplete: false,
      onReceipt: (value) => {
        receipt = value;
      },
    });
    expect(() => gate(initial())).toThrow(CodexInferenceNeedsExpansionError);
    expect(receipt).toMatchObject({
      status: "needs_expansion",
      reason: "mandatory_source_omitted",
    });
  });

  it("refuses a compact prepared needs_expansion packet even when its final bytes fit", () => {
    const compactPacket =
      '[Owner packet] {"status":"needs_expansion","reason":"mandatory_personal_context_over_budget"}';
    let receipt: CodexPersonalContextReceipt | undefined;
    const gate = createCodexPersonalPreEgressGate({
      promptText: compactPacket,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: compactPacket,
      preparedPacketNeedsExpansion: true,
      onReceipt: (value) => {
        receipt = value;
      },
    });
    expect(() =>
      gate({
        instructions: legacy,
        input: [
          { type: "message", role: "user", content: compactPacket },
          { type: "message", role: "developer", content: developer },
        ],
      }),
    ).toThrow(CodexInferenceNeedsExpansionError);
    expect(receipt).toMatchObject({
      status: "needs_expansion",
      reason: "mandatory_source_omitted",
    });
  });

  it("allows a justified 16k complex read inside the selected total context budget", () => {
    const config = {
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      budgetTokens: 16000,
    };
    expect(() => createCodexPersonalPreEgressGate(config)).toThrow(
      CodexInferenceNeedsExpansionError,
    );
    expect(() =>
      createCodexPersonalPreEgressGate({
        ...config,
        expansionReason: "complex_source_read",
        totalContextTokenBudget: 12000,
      }),
    ).toThrow(CodexInferenceNeedsExpansionError);
    const receipts: CodexPersonalContextReceipt[] = [];
    const gate = createCodexPersonalPreEgressGate({
      ...config,
      expansionReason: "complex_source_read",
      totalContextTokenBudget: 32000,
      onReceipt: (receipt) => receipts.push(receipt),
    });
    gate(initial());
    gate({
      previous_response_id: "resp-1",
      input: [{ type: "function_call_output", call_id: "complex-read", output: "x".repeat(9000) }],
    });
    expect(receipts.at(-1)).toMatchObject({
      budgetTokens: 16000,
      expansionReason: "complex_source_read",
      status: "within_bound",
    });
    expect(receipts.at(-1)?.upperBoundUtf8Bytes).toBeGreaterThan(8000);
  });

  it("keeps committed tool reads charged across a fresh native generation", () => {
    const receipts: CodexPersonalContextReceipt[] = [];
    const config = {
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      replayedToolReads: [
        { callId: "read-before-refresh", upperBoundUtf8Bytes: 7000 },
        { callId: "read-before-refresh", upperBoundUtf8Bytes: 7000 },
      ],
      onReceipt: (receipt: CodexPersonalContextReceipt) => receipts.push(receipt),
    };
    const gate = createCodexPersonalPreEgressGate(config);
    gate(initial());
    expect(receipts[0]).toMatchObject({ cumulativeToolOutputs: 1 });
    expect(receipts[0]?.upperBoundUtf8Bytes).toBeGreaterThan(7000);
    gate({
      previous_response_id: "resp-1",
      input: [
        { type: "function_call_output", call_id: "read-before-refresh", output: "replayed source" },
      ],
    });
    expect(receipts[1]?.upperBoundUtf8Bytes).toBe(receipts[0]?.upperBoundUtf8Bytes);
    expect(() =>
      gate({
        previous_response_id: "resp-2",
        input: [
          {
            type: "function_call_output",
            call_id: "new-read-after-refresh",
            output: "x".repeat(1200),
          },
        ],
      }),
    ).toThrow(CodexInferenceNeedsExpansionError);
    expect(receipts.at(-1)).toMatchObject({ status: "needs_expansion", cumulativeToolOutputs: 2 });
  });

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
    expect(first).toBe(Buffer.byteLength(prompt + legacy + developer));
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
    expect(Buffer.byteLength(cyrillicPacket, "utf8")).toBeGreaterThan(
      Array.from(cyrillicPacket).length,
    );
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

  it("keeps unrelated native soul policy outside the USER personal block", () => {
    let bound = 0;
    const gate = createCodexPersonalPreEgressGate({
      promptText: prompt,
      developerInstructions: developer,
      legacySegments: [{ name: "USER.md", text: legacy }],
      packetText: packet,
      onReceipt: (receipt) => {
        bound = receipt.upperBoundUtf8Bytes;
      },
    });
    const request = {
      ...initial(),
      instructions: `${"native soul policy ".repeat(1000)}\n${legacy}`,
    };
    gate(request);
    expect(bound).toBe(Buffer.byteLength(prompt + legacy + developer));
  });
});
