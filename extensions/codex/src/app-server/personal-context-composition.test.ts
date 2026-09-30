import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexInferenceNeedsExpansionError } from "./inference-context.js";
import {
  createCodexPersonalPreEgressGate,
  type CodexPersonalContextReceipt,
} from "./personal-context-gate.js";

// Cross-repository integration is explicit: the reserved production job supplies
// the exact reviewed Ops snapshot, never a live plugin or production state.
const opsRoot = process.env.PATI_CONTEXT_COMPOSITION_OPS_ROOT;
describe.skipIf(!opsRoot)("actual Owner plugin composition at the OAuth boundary", () => {
  it("keeps USER, MEMORY and a current fact within 8k while separately verifying product policy", async () => {
    const { registerPersonalAssistance } = await import(
      /* @vite-ignore */ pathToFileURL(`${opsRoot}/guest/arxi-channel/personal-assistance.mjs`).href
    );
    const { registerCommunication } = await import(
      /* @vite-ignore */ pathToFileURL(`${opsRoot}/guest/arxi-channel/communication.mjs`).href
    );
    const { OWNER_SOURCE_DECISION_POLICY } = await import(
      /* @vite-ignore */ pathToFileURL(
        `${opsRoot}/guest/arxi-channel/personal-assistance-decision-policy.mjs`,
      ).href
    );
    const user = "### /workspace/USER.md\n\nОтвечай коротко. Не отправляй личное в группы.\n\n";
    const memory = "## /workspace/MEMORY.md\n\nВладелец предпочитает пешие прогулки.\n\n";
    const legacySegments = [
      { name: "USER.md", text: user },
      { name: "MEMORY.md", text: memory },
    ].map((segment) => ({
      ...segment,
      path: `/workspace/${segment.name}`,
      mandatory: true,
      sha256: createHash("sha256").update(segment.text).digest("hex"),
    }));
    const staticPolicies: Array<{ id: string; text: string }> = [];
    let packet: { text: string; budgetTokens: number; needsExpansion?: boolean } | undefined;
    const personalPrompt = {
      legacySegments,
      countInputUtf8UpperBound: (input: { instructions: string; prompt: string }) =>
        Buffer.byteLength(`${input.instructions}\n\n${input.prompt}`, "utf8"),
      registerPreparedPacket: (value: {
        text: string;
        budgetTokens: number;
        needsExpansion?: boolean;
      }) => {
        packet = value;
      },
      registerStaticPolicy: (policy: { id: string; text: string }) => staticPolicies.push(policy),
    };
    const currentText = "Встреча с Мариной завтра в 15:00, адрес уточним.";
    const controls = [
      {
        ownerUpdateId: 17,
        version: 1,
        scope: "chat",
        mode: "pause",
        dimension: "reply",
        connectionId: "business-1",
        generation: 1,
        chatId: 42,
      },
    ];
    const context = {
      agentId: "main",
      trigger: "user",
      runId: "test-owner-composition",
      sessionKey: "agent:main:owner-private",
      trace: { traceId: "a".repeat(32) },
      requester: { senderIsOwner: true, conversationId: "telegram-chat:42" },
      personalPrompt,
    };
    let communicationHook: (event: unknown, context: unknown) => { appendSystemContext: string };
    registerCommunication(
      {
        on: (_name: string, hook: typeof communicationHook) => {
          communicationHook = hook;
        },
      },
      "owner",
    );
    const communication = communicationHook!({}, context);
    let personalHook: (
      event: unknown,
      context: unknown,
    ) => Promise<{ appendContext: string; appendSystemContext: string }>;
    registerPersonalAssistance(
      {
        on: (_name: string, hook: typeof personalHook) => {
          personalHook = hook;
        },
      },
      {
        recordEpisodes: async () => [],
        loadEpisodes: async () => [],
        loadPrivateGoals: async () => ({ episodes: [] }),
        loadEpisodeSummaries: async () => [],
        searchMemory: async () => ({ status: "searched", candidates: [] }),
        loadScopedControls: async () => ({ controls, complete: true }),
        read: async () => ({ messages: [] }),
        readPrivateSource: async () => ({
          messages: [
            {
              connectionId: "owner-private:primary",
              generation: 1,
              chatId: 42,
              messageId: 9,
              updateId: 19,
              direction: "outgoing",
              text: currentText,
            },
          ],
        }),
      },
    );
    const result = await personalHook!({ currentUserMessage: currentText }, context);
    expect(result?.appendContext).toContain(currentText);
    expect(result?.appendSystemContext).toContain(OWNER_SOURCE_DECISION_POLICY);
    expect(
      JSON.parse(result.appendContext.split("\n").slice(1).join("\n")).assistanceControls,
    ).toEqual(controls);
    expect(packet?.text).toBe(result.appendContext);
    const developer = `${communication.appendSystemContext}\n\n${result.appendSystemContext}\n\nOwner current private preference: do not interrupt this afternoon.`;
    const prompt = `${result.appendContext}\n\n${currentText}`;
    const receipts: CodexPersonalContextReceipt[] = [];
    const config = {
      promptText: prompt,
      currentUserMessage: currentText,
      developerInstructions: developer,
      legacySegments,
      packetText: packet!.text,
      staticPolicies,
      expectedModel: "gpt-6.1-sol",
      budgetTokens: packet!.budgetTokens,
      preparedPacketNeedsExpansion: packet!.needsExpansion,
      onReceipt: (receipt: CodexPersonalContextReceipt) => receipts.push(receipt),
    };
    const body = {
      model: "gpt-6.1-sol",
      instructions: `${user}${memory}`,
      input: [
        { type: "message", role: "developer", content: developer },
        { type: "message", role: "user", content: prompt },
      ],
    };
    createCodexPersonalPreEgressGate(config)(body);
    expect(receipts[0]).toMatchObject({
      status: "within_bound",
      budgetTokens: 8000,
      exactPersonalTokens: null,
    });
    expect(receipts[0]?.upperBoundUtf8Bytes).toBeGreaterThan(
      Buffer.byteLength(user + memory + packet!.text),
    );
    expect(receipts[0]?.upperBoundUtf8Bytes).toBeLessThan(8000);
    expect(receipts[0]?.staticPolicyUpperBoundUtf8Bytes).toBeGreaterThan(8000);
    expect(receipts[0]?.staticPolicies.map((policy) => policy.id)).toEqual([
      "arxi.owner-communication",
      "arxi.owner-source-guidance",
    ]);
    expect(JSON.stringify(receipts)).not.toContain("Мариной");
    expect(() =>
      createCodexPersonalPreEgressGate(config)({ ...body, instructions: memory }),
    ).toThrow(CodexInferenceNeedsExpansionError);
    expect(receipts.at(-1)).toMatchObject({
      status: "needs_expansion",
      reason: "source_attribution_changed",
    });
    expect(() => createCodexPersonalPreEgressGate({ ...config, staticPolicies: [] })(body)).toThrow(
      CodexInferenceNeedsExpansionError,
    );
    console.info(
      "OWNER_COMPOSITION_MEASURE",
      JSON.stringify({
        personalUtf8UpperBound: receipts[0]?.upperBoundUtf8Bytes,
        staticPolicyUtf8Bytes: receipts[0]?.staticPolicyUpperBoundUtf8Bytes,
        policyDigests: receipts[0]?.staticPolicies,
        packetUtf8Bytes: Buffer.byteLength(packet!.text),
      }),
    );
  });

  it("rejects incomplete and overbudget mandatory controls from the real registered Owner hook", async () => {
    const { registerPersonalAssistance } = await import(
      /* @vite-ignore */ pathToFileURL(`${opsRoot}/guest/arxi-channel/personal-assistance.mjs`).href
    );
    for (const { complete, count, failure } of [
      { complete: false, count: 1, failure: undefined },
      { complete: true, count: 50, failure: undefined },
      { complete: true, count: 0, failure: "unavailable" },
      { complete: true, count: 0, failure: "invalid_shape" },
    ]) {
      const controls = Array.from({ length: count }, (_, index) => ({
        ownerUpdateId: 50 + index,
        version: 1,
        scope: "chat",
        mode: "pause",
        dimension: "reply",
        connectionId: "business-control-case",
        generation: 1,
        chatId: 42 + index,
      }));
      const staticPolicies: Array<{ id: string; text: string }> = [];
      let packet: { text: string; budgetTokens: number; needsExpansion?: boolean } | undefined;
      const user = "### /workspace/USER.md\n\nKeep mandatory Owner instructions.\n\n";
      const legacySegments = [
        {
          name: "USER.md",
          path: "/workspace/USER.md",
          text: user,
          sha256: createHash("sha256").update(user).digest("hex"),
          mandatory: true,
        },
      ];
      const personalPrompt = {
        legacySegments,
        countInputUtf8UpperBound: (input: { instructions: string; prompt: string }) =>
          Buffer.byteLength(`${input.instructions}\n\n${input.prompt}`),
        registerPreparedPacket: (value: typeof packet) => {
          packet = value;
        },
        registerStaticPolicy: (value: { id: string; text: string }) => staticPolicies.push(value),
      };
      let hook: (
        event: unknown,
        context: unknown,
      ) => Promise<{ appendContext: string; appendSystemContext: string }>;
      registerPersonalAssistance(
        {
          on: (_name: string, value: typeof hook) => {
            hook = value;
          },
        },
        {
          recordEpisodes: async () => [],
          loadEpisodes: async () => [],
          loadPrivateGoals: async () => ({ episodes: [] }),
          loadEpisodeSummaries: async () => [],
          searchMemory: async () => ({ status: "searched", candidates: [] }),
          loadScopedControls: async () => {
            if (failure === "unavailable") throw new Error("Unavailable mandatory controls");
            return { controls: failure === "invalid_shape" ? undefined : controls, complete };
          },
          read: async () => ({ messages: [] }),
          readPrivateSource: async () => ({
            messages: [
              {
                connectionId: "owner-private:primary",
                generation: 1,
                chatId: 42,
                messageId: 9,
                updateId: 19,
                direction: "outgoing",
                text: "Текущий вопрос",
              },
            ],
          }),
        },
      );
      const result = await hook!(
        { currentUserMessage: "Текущий вопрос" },
        {
          agentId: "main",
          trigger: "user",
          runId: "test-owner-controls",
          sessionKey: "agent:main:owner-private",
          trace: { traceId: "b".repeat(32) },
          requester: { senderIsOwner: true, conversationId: "telegram-chat:42" },
          personalPrompt,
        },
      );
      const parsed = JSON.parse(result.appendContext.split("\n").slice(1).join("\n"));
      expect(parsed.status).toBe("needs_expansion");
      if (count) expect(parsed.assistanceControls).toEqual(controls);
      if (failure) expect(parsed.reason).toBe("owner_assistance_controls_unavailable");
      expect(packet?.needsExpansion).toBe(true);
      if (!complete) expect(Buffer.byteLength(packet!.text + user)).toBeLessThan(8000);
      let receipt: CodexPersonalContextReceipt | undefined;
      const gate = createCodexPersonalPreEgressGate({
        promptText: packet!.text,
        developerInstructions: result.appendSystemContext,
        legacySegments,
        packetText: packet!.text,
        staticPolicies,
        preparedPacketNeedsExpansion: packet!.needsExpansion,
        onReceipt: (value) => {
          receipt = value;
        },
      });
      expect(() =>
        gate({
          instructions: user,
          input: [
            { type: "message", role: "user", content: packet!.text },
            { type: "message", role: "developer", content: result.appendSystemContext },
          ],
        }),
      ).toThrow(CodexInferenceNeedsExpansionError);
      expect(receipt).toMatchObject({
        status: "needs_expansion",
        reason: "mandatory_source_omitted",
      });
    }
  });
});
