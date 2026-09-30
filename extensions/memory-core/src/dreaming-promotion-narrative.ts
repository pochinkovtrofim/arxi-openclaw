import type { NarrativePhaseData } from "./dreaming-narrative.js";
import type { PromotionCandidate } from "./short-term-promotion-types.js";

export function buildDeepPromotionNarrative(candidates: PromotionCandidate[]): NarrativePhaseData {
  return {
    phase: "deep",
    snippets: candidates.map((c) => c.snippet).filter(Boolean),
    promotions: candidates.map((c) => c.snippet).filter(Boolean),
    sourceEntryKeys: [...new Set(candidates.map((c) => c.key))],
    sourceRefs: candidates.flatMap((candidate) => candidate.sourceRefs ?? []),
  };
}
