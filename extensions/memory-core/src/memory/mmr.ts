import type { ResolvedMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { tokenize } from "./tokenize.js";

// Carbonell & Goldstein (1998): maximize λ * relevance - (1-λ) * similarity.

type MMRItem = {
  score: number;
  snippet: string;
};

export type MMRConfig = ResolvedMemorySearchConfig["query"]["hybrid"]["mmr"];

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

type PreparedMMRItem<T extends MMRItem> = {
  item: T;
  score: number;
  /** Sorted token ids: Jaccard by merge instead of string-set lookups. */
  tokens: Int32Array;
  emptyTokenText: string | undefined;
  relevance: number;
  maxSimilarity: number;
};

export function applyMMRToHybridResults<T extends MMRItem>(items: T[], lambda: number): T[] {
  return Array.from(iterateMMR(items, lambda));
}

/**
 * Yield items in MMR order. Greedy selection fixes each position before the
 * next is chosen, so a caller that needs only the first results stops after
 * those instead of paying the full quadratic ordering.
 */
export function* iterateMMR<T extends MMRItem>(items: T[], lambda: number): Generator<T> {
  if (items.length <= 1) {
    yield* items;
    return;
  }
  const clampedLambda = Math.max(0, Math.min(1, lambda));
  if (clampedLambda === 1) {
    yield* items.toSorted((a, b) => b.score - a.score);
    return;
  }
  const tokenIds = new Map<string, number>();
  const prepared: PreparedMMRItem<T>[] = items.map((item) => {
    const snippet = item.snippet;
    const words = tokenize(snippet);
    const tokens = Int32Array.from(words, (word) => {
      let id = tokenIds.get(word);
      if (id === undefined) {
        id = tokenIds.size;
        tokenIds.set(word, id);
      }
      return id;
    }).toSorted();
    return {
      item,
      score: item.score,
      tokens,
      emptyTokenText: words.size === 0 ? normalizeLowercaseStringOrEmpty(snippet) : undefined,
      relevance: 0,
      maxSimilarity: 0,
    };
  });
  const maxScore = Math.max(...prepared.map((item) => item.score));
  const minScore = Math.min(...prepared.map((item) => item.score));
  const scoreRange = maxScore - minScore;
  for (const item of prepared) {
    item.relevance = scoreRange === 0 ? 1 : (item.score - minScore) / scoreRange;
  }
  const remaining = new Set(prepared);
  while (remaining.size > 0) {
    let bestItem: PreparedMMRItem<T> | null = null;
    let bestMMRScore = -Infinity;
    for (const candidate of remaining) {
      const mmrScore =
        clampedLambda * candidate.relevance - (1 - clampedLambda) * candidate.maxSimilarity;
      if (
        mmrScore > bestMMRScore ||
        (mmrScore === bestMMRScore && candidate.score > (bestItem?.score ?? -Infinity))
      ) {
        bestMMRScore = mmrScore;
        bestItem = candidate;
      }
    }
    if (!bestItem) {
      break;
    }
    yield bestItem.item;
    remaining.delete(bestItem);
    // A selected item's contribution never changes, so update each candidate's
    // running maximum once per pair instead of rescanning selected items.
    for (const candidate of remaining) {
      const similarity =
        candidate.tokens.length === 0 && bestItem.tokens.length === 0
          ? Number(candidate.emptyTokenText === bestItem.emptyTokenText)
          : sortedJaccard(candidate.tokens, bestItem.tokens);
      if (similarity > candidate.maxSimilarity) {
        candidate.maxSimilarity = similarity;
      }
    }
  }
}

// Same value as jaccardSimilarity over the original token sets.
function sortedJaccard(left: Int32Array, right: Int32Array): number {
  let shared = 0;
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    // SAFETY: the loop condition keeps both indexes inside their arrays.
    const a = left[i]!;
    const b = right[j]!;
    if (a === b) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (a < b) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return shared / (left.length + right.length - shared);
}
