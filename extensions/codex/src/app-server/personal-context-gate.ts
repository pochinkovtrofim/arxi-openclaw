import { createHash } from "node:crypto";
import { CodexInferenceNeedsExpansionError } from "./inference-context.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

const DEFAULT_BUDGET = 8_000;

export type CodexPersonalContextReceipt = {
  accounting: "conservative_utf8_upper_bound";
  exactPersonalTokens: null;
  requestSha256: string;
  model?: string;
  requestSequence: number;
  upperBoundUtf8Bytes: number;
  budgetTokens: number;
  expansionReason?: "complex_source_read";
  totalContextTokenBudget?: number;
  sourceRefs?: readonly { kind: string; sha256: string }[];
  sources: readonly { name: string; sha256: string }[];
  instructionSources: readonly { name: string; sha256: string }[];
  nativeRequestAccounting: "serialized_native_request_utf8_upper_bound";
  nativeRequestUpperBoundUtf8Bytes: number;
  nativeRequestScope: "current_serialized_request_excludes_prior_provider_cache";
  nativeContextBudgetAuthority: "host_bound" | "native_owned_unavailable";
  staticPolicies: readonly { id: string; sha256: string; upperBoundUtf8Bytes: number }[];
  staticPolicyUpperBoundUtf8Bytes: number;
  ordinarySessionUpperBoundUtf8Bytes: number;
  ordinarySessionSha256: string;
  packetSha256?: string;
  newToolOutputs: number;
  cumulativeToolOutputs: number;
  status: "within_bound" | "needs_expansion";
  reason?:
    | "invalid_request"
    | "selected_model_changed"
    | "source_attribution_changed"
    | "personal_context_over_bound"
    | "native_request_over_bound"
    | "mandatory_source_omitted";
};

type PersonalSource = { name: string; text: string };
type ToolOutput = { key: string; callId: string; serialized: string };

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
  return { key: `${type}:${callId}`, callId, serialized: JSON.stringify(item) };
}

/**
 * The native OAuth request is the authority for what was actually inserted.
 * Personal file blocks include their exact headings and separators; generic
 * sibling policy in the same native leaf is outside the personal budget.
 * Codex 0.156.1 unified_exec explicitly treats byte length
 * as a conservative hard token bound for byte-fallback tokenizers. This is
 * never an exact selected-model tokenizer count.
 */
export function createCodexPersonalPreEgressGate(params: {
  promptText: string;
  currentUserMessage?: string;
  ordinarySessionSegments?: readonly string[];
  developerInstructions: string;
  developerBaseInstructions?: string;
  staticPolicies?: readonly { id: string; text: string }[];
  legacySegments: readonly PersonalSource[];
  packetText?: string;
  expectedModel?: string;
  mandatorySourcesComplete?: boolean;
  mandatoryInstructionSegments?: readonly PersonalSource[];
  preparedPacketNeedsExpansion?: boolean;
  budgetTokens?: number;
  expansionReason?: "complex_source_read";
  totalContextTokenBudget?: number;
  sourceRefs?: readonly { kind: string; sha256: string }[];
  replayedToolReads?: readonly { callId: string; upperBoundUtf8Bytes: number }[];
  onReceipt?: (receipt: CodexPersonalContextReceipt) => void;
}): (body: JsonObject) => void {
  const budgetTokens = params.budgetTokens ?? DEFAULT_BUDGET;
  if (budgetTokens !== DEFAULT_BUDGET && budgetTokens !== 16_000) {
    throw new CodexInferenceNeedsExpansionError();
  }
  if (
    budgetTokens > DEFAULT_BUDGET &&
    (params.expansionReason !== "complex_source_read" ||
      !params.totalContextTokenBudget ||
      params.totalContextTokenBudget < budgetTokens)
  ) {
    throw new CodexInferenceNeedsExpansionError();
  }
  const base = params.developerBaseInstructions ?? "";
  const instructionSegments = (params.mandatoryInstructionSegments ?? []).map((source) => ({
    ...source,
  }));
  const instructionSources = instructionSegments.map((source) => ({
    name: source.name,
    sha256: createHash("sha256").update(source.text).digest("hex"),
  }));
  // These finite declarations are made by reviewed plugin code, never inferred
  // from arbitrary hook output. Retain snapshots for this physical request gate.
  const staticPolicies = (params.staticPolicies ?? []).map((policy) => ({ ...policy }));
  const ordinarySessionSegments = [...(params.ordinarySessionSegments ?? [])];
  const staticPolicyReceipt = staticPolicies.map((policy) => ({
    id: policy.id,
    sha256: createHash("sha256").update(policy.text).digest("hex"),
    upperBoundUtf8Bytes: Buffer.byteLength(policy.text, "utf8"),
  }));
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
  const replayedReads = new Map<string, number>();
  for (const read of params.replayedToolReads ?? []) {
    if (
      !read.callId ||
      !Number.isSafeInteger(read.upperBoundUtf8Bytes) ||
      read.upperBoundUtf8Bytes < 0
    ) {
      throw new CodexInferenceNeedsExpansionError();
    }
    replayedReads.set(
      read.callId,
      Math.max(replayedReads.get(read.callId) ?? 0, read.upperBoundUtf8Bytes),
    );
  }
  let checkedInitial = false;
  let sourceUpperBound = 0;
  let toolOutputUpperBound = [...replayedReads.values()].reduce((total, bytes) => total + bytes, 0);
  let cumulativeToolOutputs = replayedReads.size;
  let requestSequence = 0;
  return (body) => {
    requestSequence++;
    let newToolOutputs = 0;
    // Native compaction owns cached history and generated outputs. This is a
    // conservative bound on this physical request, never cached occupancy or
    // a sum of repeated instruction overrides across incremental requests.
    const nativeRequestUpperBoundUtf8Bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    const emitReceipt = (
      status: CodexPersonalContextReceipt["status"],
      reason?: CodexPersonalContextReceipt["reason"],
    ) => {
      params.onReceipt?.({
        accounting: "conservative_utf8_upper_bound",
        exactPersonalTokens: null,
        requestSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        ...(params.expectedModel ? { model: params.expectedModel } : {}),
        requestSequence,
        upperBoundUtf8Bytes: sourceUpperBound + toolOutputUpperBound,
        budgetTokens,
        sources: sourceReceipt,
        instructionSources,
        nativeRequestAccounting: "serialized_native_request_utf8_upper_bound",
        nativeRequestUpperBoundUtf8Bytes,
        nativeRequestScope: "current_serialized_request_excludes_prior_provider_cache",
        nativeContextBudgetAuthority:
          params.totalContextTokenBudget === undefined ? "native_owned_unavailable" : "host_bound",
        staticPolicies: staticPolicyReceipt,
        staticPolicyUpperBoundUtf8Bytes: staticPolicyReceipt.reduce(
          (total, policy) => total + policy.upperBoundUtf8Bytes,
          0,
        ),
        ordinarySessionUpperBoundUtf8Bytes: ordinarySessionSegments.reduce(
          (total, text) => total + Buffer.byteLength(text, "utf8"),
          0,
        ),
        ordinarySessionSha256: createHash("sha256")
          .update(JSON.stringify(ordinarySessionSegments))
          .digest("hex"),
        ...(params.expansionReason ? { expansionReason: params.expansionReason } : {}),
        ...(params.totalContextTokenBudget
          ? { totalContextTokenBudget: params.totalContextTokenBudget }
          : {}),
        ...(params.sourceRefs ? { sourceRefs: params.sourceRefs } : {}),
        ...(packetSha256 ? { packetSha256 } : {}),
        newToolOutputs,
        cumulativeToolOutputs,
        status,
        ...(reason ? { reason } : {}),
      });
    };
    const refuse = (reason: NonNullable<CodexPersonalContextReceipt["reason"]>): never => {
      emitReceipt("needs_expansion", reason);
      throw new CodexInferenceNeedsExpansionError();
    };
    if (params.mandatorySourcesComplete === false || params.preparedPacketNeedsExpansion === true) {
      refuse("mandatory_source_omitted");
    }
    const bodyInput = Array.isArray(body.input) ? body.input : refuse("invalid_request");
    const currentInstructionRanges = new Map<
      string,
      { leaf: string; start: number; end: number }
    >();
    if (instructionSegments.length > 0) {
      const leaves = stringLeaves([body.instructions, bodyInput]);
      // The immutable native thread may retain an identical older AGENTS
      // snapshot. Only the complete, exact producer-owned base can identify
      // that copy; it never substitutes for this turn's current carrier.
      if (base && leaves.reduce((sum, leaf) => sum + occurrences(leaf, base), 0) > 1)
        refuse("source_attribution_changed");
      for (const source of instructionSegments) {
        if (!source.text) refuse("mandatory_source_omitted");
        const current = [] as Array<{ leaf: string; start: number; end: number }>;
        for (const leaf of leaves) {
          const baseStart = base ? leaf.indexOf(base) : -1;
          for (
            let start = 0;
            (start = leaf.indexOf(source.text, start)) >= 0;
            start += source.text.length
          ) {
            // The frozen renderer trims its final section separator. All
            // instruction bytes must still lie inside the exact base; only
            // trailing whitespace delimiters may follow it.
            const frozenCopy =
              baseStart >= 0 &&
              start >= baseStart &&
              start + source.text.trimEnd().length <= baseStart + base.length;
            if (!frozenCopy) current.push({ leaf, start, end: start + source.text.length });
          }
        }
        if (current.length !== 1) refuse("mandatory_source_omitted");
        currentInstructionRanges.set(source.text, current[0]);
      }
      if (
        params.totalContextTokenBudget !== undefined &&
        (!Number.isSafeInteger(params.totalContextTokenBudget) ||
          params.totalContextTokenBudget <= 0 ||
          nativeRequestUpperBoundUtf8Bytes > params.totalContextTokenBudget)
      )
        refuse("native_request_over_bound");
    }
    if (
      params.expectedModel &&
      ((!checkedInitial && body.model !== params.expectedModel) ||
        (body.model !== undefined && body.model !== params.expectedModel))
    ) {
      refuse("selected_model_changed");
    }
    const firstRequest = !checkedInitial;
    const fullHistory = body.previous_response_id == null;
    if (!checkedInitial || fullHistory) {
      const leaves = stringLeaves([body.instructions, bodyInput]);
      const attributedLeaves = new Set<string>();
      const hookLeaves = new Set<string>();
      const promptLeaves = new Set<string>();
      for (const source of sources) {
        const hits = leaves.reduce((total, leaf) => total + occurrences(leaf, source.text), 0);
        if (hits !== 1) {
          refuse("source_attribution_changed");
        }
        const matching = leaves.find((leaf) => leaf.includes(source.text));
        if (matching) {
          attributedLeaves.add(matching);
          if (source.name === "hook_developer") {
            hookLeaves.add(matching);
          }
          if (source.name === "turn_prompt") {
            promptLeaves.add(matching);
          }
        }
      }
      if (params.packetText) {
        const packetHits = leaves.reduce(
          (total, leaf) => total + occurrences(leaf, params.packetText!),
          0,
        );
        if (packetHits !== 1) {
          refuse("source_attribution_changed");
        }
      }
      const exemptionRanges = new Map<string, Array<{ start: number; end: number }>>();
      for (const source of instructionSegments) {
        const current =
          currentInstructionRanges.get(source.text) ?? refuse("mandatory_source_omitted");
        const { leaf, ...range } = current;
        const ranges = exemptionRanges.get(leaf) ?? [];
        const intersects = (other: { start: number; end: number }) =>
          range.start < other.end && other.start < range.end;
        if (ranges.some(intersects)) refuse("source_attribution_changed");
        for (const protectedText of [
          ...params.legacySegments.map((value) => value.text),
          params.promptText,
          base,
        ]) {
          if (!protectedText) continue;
          for (
            let offset = 0;
            (offset = leaf.indexOf(protectedText, offset)) >= 0;
            offset += protectedText.length
          ) {
            if (intersects({ start: offset, end: offset + protectedText.length }))
              refuse("source_attribution_changed");
          }
        }
        // Exact producer-owned system carriers retain their native budget even
        // when the provider serializes them beside a personal hook in one leaf.
        ranges.push(range);
        exemptionRanges.set(leaf, ranges);
      }
      const policyIds = new Set<string>();
      for (const policy of staticPolicies) {
        if (!policy.text || policyIds.has(policy.id)) refuse("source_attribution_changed");
        policyIds.add(policy.id);
        const hits = leaves.reduce((total, leaf) => total + occurrences(leaf, policy.text), 0);
        const matching = leaves.find((leaf) => leaf.includes(policy.text));
        if (hits !== 1 || !matching || !hookLeaves.has(matching)) {
          refuse("source_attribution_changed");
        }
        const leaf = matching!;
        const start = leaf.indexOf(policy.text);
        const end = start + policy.text.length;
        const intersects = (range: { start: number; end: number }) =>
          start < range.end && range.start < end;
        const previous = exemptionRanges.get(leaf) ?? [];
        if (previous.some(intersects)) refuse("source_attribution_changed");
        // Even a trusted declaration cannot exempt any part of mandatory files,
        // the packet/current prompt, or already exempted base native policy.
        for (const protectedText of [
          ...params.legacySegments.map((segment) => segment.text),
          params.promptText,
          base,
        ]) {
          if (!protectedText) continue;
          for (
            let offset = 0;
            (offset = leaf.indexOf(protectedText, offset)) >= 0;
            offset += protectedText.length
          ) {
            if (intersects({ start: offset, end: offset + protectedText.length })) {
              refuse("source_attribution_changed");
            }
          }
        }
        previous.push({ start, end });
        exemptionRanges.set(leaf, previous);
      }
      const ordinaryCounts = new Map<string, number>();
      for (const text of ordinarySessionSegments) {
        if (!text) refuse("source_attribution_changed");
        ordinaryCounts.set(text, (ordinaryCounts.get(text) ?? 0) + 1);
      }
      for (const [text, expectedHits] of ordinaryCounts) {
        const hits = leaves.reduce((total, leaf) => total + occurrences(leaf, text), 0);
        const leaf =
          leaves.find((entry) => entry.includes(text)) ?? refuse("source_attribution_changed");
        if (hits !== expectedHits || !promptLeaves.has(leaf)) refuse("source_attribution_changed");
        const ranges = exemptionRanges.get(leaf) ?? [];
        for (let offset = 0; (offset = leaf.indexOf(text, offset)) >= 0; offset += text.length) {
          const range = { start: offset, end: offset + text.length };
          const intersects = (other: { start: number; end: number }) =>
            range.start < other.end && other.start < range.end;
          if (ranges.some(intersects)) refuse("source_attribution_changed");
          for (const protectedText of [
            base,
            params.packetText,
            ...params.legacySegments.map((segment) => segment.text),
          ]) {
            if (!protectedText) continue;
            for (
              let protectedOffset = 0;
              (protectedOffset = leaf.indexOf(protectedText, protectedOffset)) >= 0;
              protectedOffset += protectedText.length
            ) {
              if (
                intersects({ start: protectedOffset, end: protectedOffset + protectedText.length })
              )
                refuse("source_attribution_changed");
            }
          }
          ranges.push(range);
        }
        exemptionRanges.set(leaf, ranges);
      }
      {
        const measuredSourceUpperBound = [...attributedLeaves].reduce((total, leaf) => {
          if (!hookLeaves.has(leaf) && !promptLeaves.has(leaf)) {
            return (
              total +
              params.legacySegments
                .filter((segment) => leaf.includes(segment.text))
                .reduce((bytes, segment) => bytes + Buffer.byteLength(segment.text, "utf8"), 0)
            );
          }
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
            !params.legacySegments.some((segment) => segment.text.includes(user)) &&
            !(exemptionRanges.get(leaf) ?? []).some(
              (range) =>
                leaf.indexOf(user) < range.end && range.start < leaf.indexOf(user) + user.length,
            );
          return (
            total +
            Buffer.byteLength(leaf, "utf8") -
            (exemptionRanges.get(leaf) ?? []).reduce(
              (bytes, range) =>
                bytes + Buffer.byteLength(leaf.slice(range.start, range.end), "utf8"),
              0,
            ) -
            (baseCanBeExcluded ? Buffer.byteLength(base, "utf8") : 0) -
            (userCanBeExcluded ? Buffer.byteLength(user, "utf8") : 0)
          );
        }, 0);
        // A full-history retry may change native wrappers around the same sources.
        // Check its actual rendered leaves too; never reuse a smaller first-request bound.
        sourceUpperBound = Math.max(sourceUpperBound, measuredSourceUpperBound);
        checkedInitial = true;
      }
    }
    for (const item of bodyInput) {
      const output = toolOutput(item);
      if (!output) {
        continue;
      }
      const previous = seenOutputs.get(output.key);
      if (previous !== undefined && previous !== output.serialized) {
        refuse("source_attribution_changed");
      }
      if (previous === undefined) {
        seenOutputs.set(output.key, output.serialized);
        if (!firstRequest && !replayedReads.has(output.callId)) {
          // The first full-history body can contain old outputs. The caller
          // charges only outputs appearing after its initial physical request.
          toolOutputUpperBound += Buffer.byteLength(output.serialized, "utf8");
          newToolOutputs++;
          cumulativeToolOutputs++;
        }
      }
    }
    if (sourceUpperBound + toolOutputUpperBound > budgetTokens) {
      refuse("personal_context_over_bound");
    }
    emitReceipt("within_bound");
  };
}
