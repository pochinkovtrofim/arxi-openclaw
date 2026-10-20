import type { MemoryEntryProvenance } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { applyMMRToHybridResults, iterateMMR, type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
import {
  applyRetrievalRanking,
  prepareActiveProjectKeys,
  projectScoreMultiplier,
} from "./project-ranking.js";
import {
  applyTemporalDecayToHybridResults,
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

type HybridSource = string;
type ExactPathSpecificity = 0 | 1 | 2 | 3;

export type HybridSearchResult<TSource extends HybridSource = HybridSource> = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore: number;
  textScore: number;
  snippet: string;
  source: TSource;
  importance?: number;
  triggers?: string;
  projectKey?: string;
  provenance?: MemoryEntryProvenance;
};

type HybridCandidate<TSource extends HybridSource = HybridSource> = Omit<
  HybridSearchResult<TSource>,
  "score" | "vectorScore" | "textScore"
> & {
  id: string;
  exactPathSpecificity?: ExactPathSpecificity;
};

type HybridVectorResult<TSource extends HybridSource = HybridSource> = HybridCandidate<TSource> & {
  vectorScore: number;
};

type HybridKeywordResult<TSource extends HybridSource = HybridSource> = HybridCandidate<TSource> & {
  textScore: number;
  hasBodyMatch?: boolean;
  rankingScore?: number;
  pathScore?: number;
};

export function scoreExactPathTieForTemporalDecay(contentScore: number): number {
  return (1 + Math.max(0, Math.min(1, contentScore))) / 2;
}

type MergeHybridParams<TSource extends HybridSource> = Parameters<
  typeof rankHybridResults<TSource>
>[0];

export async function mergeHybridResults<TSource extends HybridSource>(
  params: MergeHybridParams<TSource>,
): Promise<HybridSearchResult<TSource>[]> {
  return Array.from(await rankHybridResults(params));
}

/**
 * Merge and rank like mergeHybridResults, but yield the final order lazily so
 * selection can stop once it has its results instead of ordering every
 * candidate through MMR.
 */
export async function rankHybridResults<TSource extends HybridSource>(params: {
  vector: HybridVectorResult<TSource>[];
  keyword: HybridKeywordResult<TSource>[];
  vectorWeight: number;
  textWeight: number;
  isNonTextMediaPath?: (path: string) => boolean;
  workspaceDir?: string;
  sessionSourceMtimes?: ReadonlyMap<string, number | undefined>;
  memorySourceMtimes?: ReadonlyMap<string, number | undefined>;
  /** MMR configuration for diversity-aware re-ranking */
  mmr?: Partial<MMRConfig>;
  /** Temporal decay configuration for recency-aware scoring */
  temporalDecay?: Partial<TemporalDecayConfig>;
  activeProjectKeys?: readonly string[];
  /** Test hook for deterministic time-dependent behavior */
  nowMs?: number;
}): Promise<RankedHybridResults<TSource>> {
  const createCandidate = (r: HybridCandidate<TSource>) => ({
    ...r,
    vectorScore: 0,
    textScore: 0,
    rankingScore: 0,
    pathScore: 0,
    exactPathSpecificity: r.exactPathSpecificity ?? 0,
    hasBodyMatch: false,
    hasVector: false,
    hasKeyword: false,
  });
  const byId = new Map<string, ReturnType<typeof createCandidate>>();

  for (const r of params.vector) {
    byId.set(r.id, {
      ...createCandidate(r),
      vectorScore: r.vectorScore,
      hasVector: true,
    });
  }

  for (const r of params.keyword) {
    const exactPathSpecificity = r.exactPathSpecificity ?? 0;
    const existing = byId.get(r.id) ?? createCandidate(r);
    existing.textScore = r.textScore;
    existing.hasBodyMatch = r.hasBodyMatch ?? r.textScore > 0;
    existing.rankingScore = r.rankingScore ?? r.textScore;
    existing.pathScore = r.pathScore ?? 0;
    existing.exactPathSpecificity = Math.max(
      existing.exactPathSpecificity,
      exactPathSpecificity,
    ) as ExactPathSpecificity;
    existing.hasKeyword = true;
    existing.importance ??= r.importance;
    existing.triggers ??= r.triggers;
    existing.projectKey ??= r.projectKey;
    if (!existing.provenance && r.provenance) {
      existing.provenance = r.provenance;
    }
    if (r.snippet && r.snippet.length > 0) {
      existing.snippet = r.snippet;
    }
    byId.set(r.id, existing);
  }

  const temporalDecayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const merged = Array.from(byId.values()).map((entry) => {
    // Exact specificity already carries path precedence. Keep body scores as
    // the within-tier signal, and use path BM25 only for partial path-only hits.
    const keywordScore =
      entry.textScore > 0
        ? entry.rankingScore
        : entry.exactPathSpecificity > 0
          ? 0
          : entry.pathScore;
    const dropMediaTextSignal =
      entry.hasVector &&
      !entry.hasKeyword &&
      params.vectorWeight > 0 &&
      params.isNonTextMediaPath?.(entry.path) === true;
    const contentScore = dropMediaTextSignal
      ? entry.vectorScore
      : params.vectorWeight * entry.vectorScore + params.textWeight * keywordScore;
    // LIKE recall has no BM25 confidence. Weight its private ranking signal
    // through the same passes, then restore public confidence before selection.
    const lexicalRank = entry.hasBodyMatch && entry.textScore === 0 ? entry.rankingScore : 0;
    // With decay enabled, reserve the lower half of an exact tier for path
    // identity and the upper half for content relevance. This lets recency beat
    // a stale cap-selected content hit. Otherwise retain the established score.
    const rankingScore =
      entry.exactPathSpecificity > 0
        ? temporalDecayConfig.enabled
          ? scoreExactPathTieForTemporalDecay(contentScore)
          : contentScore > 0
            ? contentScore
            : 1
        : contentScore === 0
          ? lexicalRank
          : contentScore;
    return Object.assign(
      {
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        score: rankingScore,
        vectorScore: entry.vectorScore,
        textScore: entry.textScore,
        exactPathSpecificity: entry.exactPathSpecificity,
        contentScore,
        lexicalRank,
        snippet: entry.snippet,
        source: entry.source,
        importance: entry.importance,
        triggers: entry.triggers,
        projectKey: entry.projectKey,
      },
      entry.provenance ? { provenance: entry.provenance } : {},
    );
  });

  // Keep component scores as raw retrieval diagnostics. Temporal decay and MMR
  // may adjust the combined score, but cannot cross the exact-identifier tier.
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
    sessionSourceMtimes: params.sessionSourceMtimes,
    memorySourceMtimes: params.memorySourceMtimes,
    nowMs: params.nowMs,
  });
  const activeProjects = prepareActiveProjectKeys(params.activeProjectKeys);
  const rankable = applyRetrievalRanking(decayed, activeProjects).map((entry) => {
    // Exact tiers and recall-only LIKE hits keep their public confidence;
    // their private ranking score still includes every weighting pass.
    const rankingScore = entry.score;
    return Object.assign(entry, {
      rankingScore,
      score:
        entry.exactPathSpecificity > 0
          ? projectScoreMultiplier(entry.projectKey, activeProjects)
          : entry.contentScore === 0
            ? 0
            : entry.score,
    });
  });
  const compareRankingScores = (a: (typeof rankable)[number], b: (typeof rankable)[number]) =>
    b.rankingScore - a.rankingScore ||
    b.lexicalRank - a.lexicalRank ||
    a.path.localeCompare(b.path) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine;
  const nonExact = rankable
    .filter((entry) => entry.exactPathSpecificity === 0)
    .toSorted((a, b) => b.score - a.score || compareRankingScores(a, b));

  // Apply MMR re-ranking if enabled
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  const rerankExactGroup = (entries: typeof rankable) => {
    if (!mmrConfig.enabled) {
      return entries;
    }
    return applyMMRToHybridResults(
      entries.map((entry) => Object.assign(entry, { score: entry.rankingScore })),
      mmrConfig.lambda,
    ).map((entry) =>
      Object.assign(entry, {
        score: projectScoreMultiplier(entry.projectKey, activeProjects),
      }),
    );
  };
  const exact = ([3, 2, 1] as const).flatMap((specificity) => {
    const tier = rankable
      .filter((entry) => entry.exactPathSpecificity === specificity)
      .toSorted(compareRankingScores);
    if (temporalDecayConfig.enabled) {
      return rerankExactGroup(tier);
    }
    const contentBacked = tier.filter((entry) => entry.contentScore > 0 || entry.lexicalRank > 0);
    const pathOnly = tier.filter((entry) => !(entry.contentScore > 0) && entry.lexicalRank === 0);
    return rerankExactGroup(contentBacked).concat(rerankExactGroup(pathOnly));
  });
  function* ranked() {
    yield* exact;
    yield* mmrConfig.enabled ? iterateMMR(nonExact, mmrConfig.lambda) : nonExact;
  }
  return {
    // MMR reorders but never rescores, so every public score is known up front.
    candidates: [...exact, ...nonExact],
    *[Symbol.iterator]() {
      for (const {
        exactPathSpecificity: _exactPathSpecificity,
        rankingScore: _rankingScore,
        contentScore: _contentScore,
        lexicalRank: _lexicalRank,
        ...entry
      } of ranked()) {
        yield entry;
      }
    },
  };
}

/** Ranked results in final order, with every public score known before ordering. */
export type RankedHybridResults<TSource extends HybridSource = HybridSource> = Iterable<
  HybridSearchResult<TSource>
> & { candidates?: readonly (HybridResultRange<TSource> & { score: number })[] };

type HybridResultRange<TSource extends HybridSource = HybridSource> = Pick<
  HybridSearchResult<TSource>,
  "source" | "path" | "startLine" | "endLine"
>;

function hybridResultRangeKey(entry: HybridResultRange): string {
  return `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`;
}

export function selectHybridSearchResults<TSource extends HybridSource>(params: {
  merged: RankedHybridResults<TSource>;
  keyword: HybridResultRange<TSource>[];
  maxResults: number;
  minScore: number;
}): HybridSearchResult<TSource>[] {
  const keywordKeys = new Set(params.keyword.map((entry) => hybridResultRangeKey(entry)));
  // Without known scores the strict set is learned by ordering every candidate.
  const strictRanges = (params.merged.candidates ?? Array.from(params.merged))
    .filter((entry) => entry.score >= params.minScore)
    .map((entry) => hybridResultRangeKey(entry));
  const strictTotal = strictRanges.length;
  const strictWanted = Math.min(params.maxResults, strictTotal);
  // Strict recall owns the result window. MMR-ranked keyword-only hits may use
  // spare capacity, but must never displace a qualifying result. When nothing
  // qualifies, keep the established all-lexical fallback.
  const fillWanted = params.keyword.length === 0 ? 0 : params.maxResults - strictWanted;
  const strict: HybridSearchResult<TSource>[] = [];
  const fill: HybridSearchResult<TSource>[] = [];
  // Fill only runs when every strict result fits, so all their ranges are taken.
  const seen = new Set(strictRanges);
  // Consume the ranked order only until both windows are full; MMR then never
  // orders the candidates nobody reads.
  for (const entry of params.merged) {
    if (strict.length === strictWanted && fill.length === fillWanted) {
      break;
    }
    const key = hybridResultRangeKey(entry);
    if (entry.score >= params.minScore) {
      if (strict.length < strictWanted) {
        strict.push(entry);
      }
      continue;
    }
    const eligible =
      strictTotal === 0
        ? entry.score >= 0 && keywordKeys.has(key)
        : entry.vectorScore === 0 && keywordKeys.has(key) && !seen.has(key);
    if (eligible && fill.length < fillWanted) {
      seen.add(key);
      fill.push(entry);
    }
  }
  return [...strict, ...fill];
}
