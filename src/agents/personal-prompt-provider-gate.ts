import { createHash } from "node:crypto";
import type { EffectivePersonalPromptSegment } from "./system-prompt.js";

const MAX_PERSONAL_TOKENS = 16_000;
const TOKEN_COUNT_FIELDS = [
  "conversation",
  "input",
  "instructions",
  "model",
  "parallel_tool_calls",
  "personality",
  "previous_response_id",
  "reasoning",
  "text",
  "tool_choice",
  "tools",
  "truncation",
] as const;

export type PreparedPersonalPacket = Readonly<{
  text: string;
  budgetTokens: number;
}>;

export type ProviderPersonalContextReceipt = Readonly<{
  model: string;
  requestSha256: string;
  sourceSha256: string;
  fullTokens: number;
  baselineTokens: number;
  personalTokens: number;
  budgetTokens: number;
  status: "within_budget";
}>;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function replaceInInput(value: unknown, needle: string): { value: unknown; matches: number } {
  if (typeof value === "string") {
    return {
      value: value.replace(needle, ""),
      matches: countOccurrences(value, needle),
    };
  }
  if (Array.isArray(value)) {
    let matches = 0;
    const next = value.map((item) => {
      const result = replaceInInput(item, needle);
      matches += result.matches;
      return result.value;
    });
    return { value: next, matches };
  }
  if (!value || typeof value !== "object") {
    return { value, matches: 0 };
  }
  let matches = 0;
  const next = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      // Source text may appear in Responses content/text/arguments fields.
      // Restrict mutation to the provider input tree, never tools or metadata.
      const result = replaceInInput(item, needle);
      matches += result.matches;
      return [key, result.value];
    }),
  );
  return { value: next, matches };
}

function countRequestShape(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Personal context provider payload unavailable");
  }
  const request = value as Record<string, unknown>;
  if (typeof request.model !== "string" || !request.model.trim() || request.input == null) {
    throw new Error("Personal context provider payload invalid");
  }
  return Object.fromEntries(
    TOKEN_COUNT_FIELDS.filter((field) => request[field] !== undefined).map((field) => [
      field,
      structuredClone(request[field]),
    ]),
  );
}

/**
 * Counts the exact marginal input-token contribution of native USER/MEMORY plus
 * the prepared packet using two requests with the same provider request shape.
 * The first count is the actual provider-bound payload. The second removes
 * only the registered personal text, preserving roles, messages and tools.
 */
export async function verifyProviderPersonalContext(input: {
  request: unknown;
  selectedModelId: string;
  segments: readonly EffectivePersonalPromptSegment[];
  packet: PreparedPersonalPacket;
  countResponseInputTokens?: (request: Record<string, unknown>) => Promise<number>;
}): Promise<ProviderPersonalContextReceipt> {
  const { packet } = input;
  if (
    !packet.text.trim() ||
    !Number.isSafeInteger(packet.budgetTokens) ||
    packet.budgetTokens < 1 ||
    packet.budgetTokens > MAX_PERSONAL_TOKENS
  ) {
    throw new Error("Personal context packet registration invalid");
  }
  if (!input.countResponseInputTokens) {
    throw new Error("Personal context tokenizer unavailable");
  }
  const full = countRequestShape(input.request);
  if (full.model !== input.selectedModelId) {
    throw new Error("Personal context selected model changed before provider dispatch");
  }
  if (full.truncation === "auto") {
    throw new Error(
      "Personal context automatic provider truncation cannot preserve mandatory source",
    );
  }
  const baseline = structuredClone(full);
  for (const segment of input.segments) {
    const instructions = baseline.instructions;
    const instructionMatches =
      typeof instructions === "string" ? countOccurrences(instructions, segment.text) : 0;
    const replacedInput = replaceInInput(baseline.input, segment.text);
    if (instructionMatches + replacedInput.matches !== 1) {
      throw new Error("Effective USER/MEMORY missing or duplicated at provider boundary");
    }
    if (instructionMatches === 1) {
      baseline.instructions = (instructions as string).replace(segment.text, "");
    } else {
      baseline.input = replacedInput.value;
    }
  }
  const removedPacket = replaceInInput(baseline.input, packet.text);
  if (removedPacket.matches !== 1) {
    throw new Error("Personal context packet missing or duplicated at provider boundary");
  }
  baseline.input = removedPacket.value;
  const fullTokens = await input.countResponseInputTokens(full);
  const baselineTokens = await input.countResponseInputTokens(baseline);
  if (
    !Number.isSafeInteger(fullTokens) ||
    !Number.isSafeInteger(baselineTokens) ||
    fullTokens < baselineTokens ||
    baselineTokens < 0
  ) {
    throw new Error("Personal context provider token receipt invalid");
  }
  const personalTokens = fullTokens - baselineTokens;
  if (personalTokens > packet.budgetTokens) {
    throw new Error("Personal context needs_expansion before provider dispatch");
  }
  return {
    model: input.selectedModelId,
    // Bind the receipt to the complete request handed to the SDK, including
    // non-token-bearing transport fields excluded from the count endpoint.
    requestSha256: createHash("sha256").update(JSON.stringify(input.request)).digest("hex"),
    sourceSha256: createHash("sha256")
      .update(JSON.stringify([input.segments.map(({ sha256 }) => sha256), packet.text]))
      .digest("hex"),
    fullTokens,
    baselineTokens,
    personalTokens,
    budgetTokens: packet.budgetTokens,
    status: "within_budget",
  };
}
