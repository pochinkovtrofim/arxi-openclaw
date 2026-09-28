import { createHash } from "node:crypto";
import { CodexInferenceNeedsExpansionError } from "./inference-context.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

const DEFAULT_BUDGET = 8_000;

type PersonalSource = { name: string; text: string };
type ToolOutput = { key: string; serialized: string };

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringLeaves);
  }
  return isJsonObject(value) ? Object.values(value).flatMap(stringLeaves) : [];
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let offset = 0; (offset = haystack.indexOf(needle, offset)) >= 0; offset += needle.length) {
    count++;
  }
  return count;
}

function toolOutput(item: unknown): ToolOutput | undefined {
  if (!isJsonObject(item)) {
    return undefined;
  }
  const type = item.type;
  if (
    typeof type !== "string" ||
    !(type.endsWith("_output") || (type === "message" && item.role === "tool"))
  ) {
    return undefined;
  }
  const callId = item.call_id ?? item.id;
  if (typeof callId !== "string" || !callId) {
    throw new CodexInferenceNeedsExpansionError();
  }
  return { key: `${type}:${callId}`, serialized: JSON.stringify(item) };
}

/**
 * The native OAuth request is the authority for what was actually inserted.
 * Full string leaves also charge every visible heading and separator around an
 * attributed source. Codex 0.156.1 unified_exec explicitly treats byte length
 * as a conservative hard token bound for byte-fallback tokenizers. This is
 * never an exact selected-model tokenizer count.
 */
export function createCodexPersonalPreEgressGate(params: {
  promptText: string;
  currentUserMessage?: string;
  developerInstructions: string;
  developerBaseInstructions?: string;
  legacySegments: readonly PersonalSource[];
  packetText?: string;
  budgetTokens?: number;
  onReceipt?: (receipt: {
    upperBoundUtf8Bytes: number;
    budgetTokens: number;
    sources: readonly { name: string; sha256: string }[];
    packetSha256?: string;
    newToolOutputs: number;
  }) => void;
}): (body: JsonObject) => void {
  const budgetTokens = params.budgetTokens ?? DEFAULT_BUDGET;
  if (budgetTokens !== DEFAULT_BUDGET && budgetTokens !== 16_000) {
    throw new CodexInferenceNeedsExpansionError();
  }
  const base = params.developerBaseInstructions ?? "";
  const developerOffset = base ? params.developerInstructions.indexOf(base) : -1;
  const developerAdditions =
    developerOffset < 0
      ? [params.developerInstructions]
      : [
          params.developerInstructions.slice(0, developerOffset),
          params.developerInstructions.slice(developerOffset + base.length),
        ];
  const sources = [
    ...params.legacySegments,
    { name: "turn_prompt", text: params.promptText },
    ...developerAdditions.map((text) => ({ name: "hook_developer", text })),
  ].filter((source) => source.text.length > 0);
  const sourceReceipt = sources.map((source) => ({
    name: source.name,
    sha256: createHash("sha256").update(source.text).digest("hex"),
  }));
  const packetSha256 = params.packetText
    ? createHash("sha256").update(params.packetText).digest("hex")
    : undefined;
  if (params.packetText && !params.promptText.includes(params.packetText)) {
    // Host-side fitting must never silently remove or replace the packet.
    throw new CodexInferenceNeedsExpansionError();
  }
  const seenOutputs = new Map<string, string>();
  let checkedInitial = false;
  let upperBoundUtf8Bytes = 0;
  return (body) => {
    if (!Array.isArray(body.input)) {
      throw new CodexInferenceNeedsExpansionError();
    }
    const firstRequest = !checkedInitial;
    const fullHistory = body.previous_response_id == null;
    if (!checkedInitial || fullHistory) {
      const leaves = stringLeaves([body.instructions, body.input]);
      const attributedLeaves = new Set<string>();
      const hookLeaves = new Set<string>();
      for (const source of sources) {
        const hits = leaves.reduce((total, leaf) => total + occurrences(leaf, source.text), 0);
        if (hits !== 1) {
          throw new CodexInferenceNeedsExpansionError();
        }
        const matching = leaves.find((leaf) => leaf.includes(source.text));
        if (matching) {
          attributedLeaves.add(matching);
          if (source.name === "hook_developer") {
            hookLeaves.add(matching);
          }
        }
      }
      if (params.packetText) {
        const packetHits = leaves.reduce(
          (total, leaf) => total + occurrences(leaf, params.packetText!),
          0,
        );
        if (packetHits !== 1) {
          throw new CodexInferenceNeedsExpansionError();
        }
      }
      if (!checkedInitial) {
        upperBoundUtf8Bytes = [...attributedLeaves].reduce((total, leaf) => {
          const baseOccurrences = base ? occurrences(leaf, base) : 0;
          const baseCanBeExcluded =
            hookLeaves.has(leaf) &&
            baseOccurrences === 1 &&
            !params.legacySegments.some((segment) => base.includes(segment.text)) &&
            !params.packetText?.includes(base);
          const user = params.currentUserMessage ?? "";
          const userCanBeExcluded =
            user.length > 0 &&
            leaf.includes(params.promptText) &&
            occurrences(leaf, user) === 1 &&
            !params.packetText?.includes(user) &&
            !params.legacySegments.some((segment) => segment.text.includes(user));
          return (
            total +
            Buffer.byteLength(leaf, "utf8") -
            (baseCanBeExcluded ? Buffer.byteLength(base, "utf8") : 0) -
            (userCanBeExcluded ? Buffer.byteLength(user, "utf8") : 0)
          );
        }, 0);
        checkedInitial = true;
      }
    }
    let newToolOutputs = 0;
    for (const item of body.input) {
      const output = toolOutput(item);
      if (!output) {
        continue;
      }
      const previous = seenOutputs.get(output.key);
      if (previous !== undefined && previous !== output.serialized) {
        throw new CodexInferenceNeedsExpansionError();
      }
      if (previous === undefined) {
        seenOutputs.set(output.key, output.serialized);
        if (!firstRequest) {
          // The first full-history body can contain old outputs. The caller
          // charges only outputs appearing after its initial physical request.
          upperBoundUtf8Bytes += Buffer.byteLength(output.serialized, "utf8");
          newToolOutputs++;
        }
      }
    }
    if (upperBoundUtf8Bytes > budgetTokens) {
      throw new CodexInferenceNeedsExpansionError();
    }
    params.onReceipt?.({
      upperBoundUtf8Bytes,
      budgetTokens,
      sources: sourceReceipt,
      ...(packetSha256 ? { packetSha256 } : {}),
      newToolOutputs,
    });
  };
}
