import {
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  formatMemoryDreamingDay,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { buildPromotionMarker } from "./short-term-promotion-memory-write.js";
import {
  buildPromotionRecallAnnotations,
  groupPromotionCandidatesByProjectKey,
} from "./short-term-promotion-metadata.js";
import type { PromotionCandidate } from "./short-term-promotion-types.js";
import { normalizeSnippet, toFiniteNonNegativeInt } from "./short-term-promotion-utils.js";

const PROMOTED_SNIPPET_CHARS_PER_TOKEN_ESTIMATE = 4;

export function buildPromotionSection(
  candidates: PromotionCandidate[],
  nowMs: number,
  timezone?: string,
  maxPromotedSnippetTokens = DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
): string {
  const sectionDate = formatMemoryDreamingDay(nowMs, timezone);
  const lines = ["", `## Promoted From Short-Term Memory (${sectionDate})`, ""];
  const projectGroups = groupPromotionCandidatesByProjectKey(candidates);

  for (const { projectKey, candidates: groupCandidates } of projectGroups) {
    if (projectGroups.length > 1) {
      lines.push(projectKey ? `### Project: ${projectKey}` : "### Global", "");
    }
    for (const candidate of groupCandidates) {
      const source = `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
      const metadata = `[score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} source=${source}]`;
      lines.push(buildPromotionMarker(candidate.key));
      // Cap only the visible MEMORY.md text. The recall store keeps the full
      // rehydrated snippet so ranking, provenance, and dream narratives remain
      // tied to the source entry instead of this presentation budget.
      lines.push(
        `- ${formatPromotedSnippetForMemory(candidate.snippet, maxPromotedSnippetTokens)} ${metadata} ${buildPromotionRecallAnnotations(candidate)}`,
      );
    }
    if (projectGroups.length > 1) {
      lines.push("");
    }
  }

  lines.push("");
  return lines.join("\n");
}

function resolvePromotedSnippetCharLimit(maxTokens: number): number {
  const tokenLimit = toFiniteNonNegativeInt(
    maxTokens,
    DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  );
  // This is an inexpensive display-size guard, not a tokenizer contract.
  return tokenLimit * PROMOTED_SNIPPET_CHARS_PER_TOKEN_ESTIMATE;
}

function truncatePromotedSnippet(snippet: string, maxTokens: number): string {
  const limit = resolvePromotedSnippetCharLimit(maxTokens);
  if (limit === 0 || snippet.length <= limit) {
    return snippet;
  }
  const hardLimit = truncateUtf16Safe(snippet, limit);
  const sentenceBoundary = Math.max(
    hardLimit.lastIndexOf(". "),
    hardLimit.lastIndexOf("! "),
    hardLimit.lastIndexOf("? "),
  );
  const wordBoundary = hardLimit.lastIndexOf(" ");
  const cutAt =
    sentenceBoundary >= Math.floor(limit * 0.55)
      ? sentenceBoundary + 1
      : wordBoundary >= Math.floor(limit * 0.65)
        ? wordBoundary
        : limit;
  return `${hardLimit.slice(0, cutAt).trimEnd()}...`;
}

function formatPromotedSnippetForMemory(rawSnippet: string, maxTokens: number): string {
  const normalized = normalizeSnippet(rawSnippet || "(no snippet captured)")
    .replace(/^[-*+] +/, "")
    .trim();
  return truncatePromotedSnippet(normalized || "(no snippet captured)", maxTokens);
}
