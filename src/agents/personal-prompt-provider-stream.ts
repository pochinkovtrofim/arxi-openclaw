import { responsesProviderRequestGate } from "@openclaw/ai/internal/openai";
import type { AssistantMessage } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  type PreparedPersonalPacket,
  type ProviderPersonalContextReceipt,
  verifyProviderPersonalContext,
} from "./personal-prompt-provider-gate.js";
import type { StreamFn } from "./runtime/index.js";
import type { EffectivePersonalPromptSegment } from "./system-prompt.js";

type PersonalPromptProviderGate = {
  legacySegments: readonly EffectivePersonalPromptSegment[];
  countResponseInputTokens?: (request: Record<string, unknown>) => Promise<number>;
  readPreparedPacket: () => PreparedPersonalPacket | undefined;
  recordProviderReceipt: (receipt: ProviderPersonalContextReceipt) => void;
};

function blockedResponse(model: Parameters<StreamFn>[0], message: string): ReturnType<StreamFn> {
  const output: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    errorMessage: message,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.end(output);
  return stream;
}

/**
 * The Responses transport calls this guard after native request preparation,
 * continuation/retry selection, and immediately before each SDK dispatch.
 * Force SSE: the WebSocket path does not yet expose an async pre-send gate.
 */
export function wrapStreamFnWithPersonalPromptProviderGate(params: {
  streamFn: StreamFn;
  personalPrompt: PersonalPromptProviderGate;
  isCompacting: () => boolean;
  nativePreEgress: boolean;
}): StreamFn {
  return (model, context, options) => {
    const packet = params.personalPrompt.readPreparedPacket();
    if (!packet) {
      return params.streamFn(model, context, options);
    }
    if (params.isCompacting()) {
      return blockedResponse(model, "Personal context provider compaction requires revalidation");
    }
    if (
      !params.nativePreEgress ||
      model.api !== "openai-responses" ||
      !params.personalPrompt.countResponseInputTokens
    ) {
      return blockedResponse(model, "Personal context tokenizer unavailable at provider boundary");
    }
    const originalOnPayload = options?.onPayload;
    const guardedOptions = {
      ...options,
      transport: "sse" as const,
      // Full-history requests keep the registered source visible to the final
      // gate on every model/tool turn. Stored HTTP continuation would omit it.
      onPayload: async (body: unknown, requestModel: Parameters<StreamFn>[0]) => {
        const transformed = await originalOnPayload?.(body, requestModel);
        // SAFETY: only a shallow payload copy is made; the final request gate validates its fields.
        return { ...((transformed ?? body) as Record<string, unknown>), store: false };
      },
    };
    responsesProviderRequestGate.set(guardedOptions, async (request) => {
      const receipt = await verifyProviderPersonalContext({
        request,
        selectedModelId: model.id,
        segments: params.personalPrompt.legacySegments,
        packet,
        countResponseInputTokens: params.personalPrompt.countResponseInputTokens,
      });
      params.personalPrompt.recordProviderReceipt(receipt);
    });
    return params.streamFn(model, context, guardedOptions);
  };
}
