import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { textSimilarity as snippetSimilarity } from "./memory/tokenize.js";
import type { ShortTermRecallEntry } from "./short-term-promotion-types.js";
import { compareStoreTimestampDesc } from "./short-term-promotion-utils.js";

// Use the shared CJK-aware similarity helper so close-but-not-identical CJK
// snippets do not slip past the dedupe threshold via the old ASCII-only path.
export function dedupeEntries(
  entries: ShortTermRecallEntry[],
  threshold: number,
): Array<ShortTermRecallEntry & { sourceEntryKeys: string[] }> {
  const deduped: Array<ShortTermRecallEntry & { sourceEntryKeys: string[] }> = [];
  for (const entry of entries) {
    const duplicate = deduped.find(
      (candidate) =>
        candidate.path === entry.path &&
        snippetSimilarity(candidate.snippet, entry.snippet) >= threshold,
    );
    if (duplicate) {
      // Merged tags also become narrative input, so retain their source keys.
      duplicate.sourceEntryKeys.push(entry.key);
      duplicate.sourceRefs = [
        ...new Map(
          [...(duplicate.sourceRefs ?? []), ...(entry.sourceRefs ?? [])].map((ref) => [
            JSON.stringify([ref.ownerId, ref.value]),
            ref,
          ]),
        ).values(),
      ];
      if (entry.recallCount > duplicate.recallCount) {
        duplicate.recallCount = entry.recallCount;
      }
      duplicate.totalScore = Math.max(duplicate.totalScore, entry.totalScore);
      duplicate.maxScore = Math.max(duplicate.maxScore, entry.maxScore);
      duplicate.queryHashes = uniqueStrings([...duplicate.queryHashes, ...entry.queryHashes]);
      duplicate.userQueryHashes = uniqueStrings([
        ...(duplicate.userQueryHashes ?? []),
        ...(entry.userQueryHashes ?? []),
      ]);
      duplicate.recallDays = [
        ...new Set([...duplicate.recallDays, ...entry.recallDays]),
      ].toSorted();
      duplicate.conceptTags = uniqueStrings([...duplicate.conceptTags, ...entry.conceptTags]);
      duplicate.lastRecalledAt =
        compareStoreTimestampDesc(entry.lastRecalledAt, duplicate.lastRecalledAt) < 0
          ? entry.lastRecalledAt
          : duplicate.lastRecalledAt;
      continue;
    }
    deduped.push({ ...entry, sourceEntryKeys: [entry.key] });
  }
  return deduped;
}
