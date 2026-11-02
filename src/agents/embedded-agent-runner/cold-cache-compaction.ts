import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelExtraParamSources } from "../model-extra-params.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";

const DEFAULT_COLD_CACHE_COMPACTION_TOKENS = 150_000;
// Anthropic prompt-cache lifetimes for the "short" (5m) and "long" (1h) retentions.
const PROMPT_CACHE_TTL_MS = { short: 5 * 60_000, long: 60 * 60_000 } as const;

/**
 * Once a session's prompt cache has expired, its next request rewrites the whole history
 * at the cache-write rate. Compacting first makes that rewrite the summary instead.
 */
export function resolveColdCacheCompaction(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
}): { minTokens: number; ttlMs: number } | undefined {
  const { cfg, provider, modelId, agentId } = params;
  const minTokens =
    cfg?.agents?.defaults?.compaction?.coldCacheTokens ?? DEFAULT_COLD_CACHE_COMPACTION_TOKENS;
  if (minTokens <= 0) {
    return undefined;
  }
  const sources = resolveModelExtraParamSources({ config: cfg, provider, modelId, agentId });
  const retention = resolveCacheRetention(
    Object.assign(
      {},
      sources.defaultParams,
      sources.modelParams,
      sources.agentModelParams,
      sources.agentParams,
    ),
    provider,
    undefined,
    modelId,
  );
  return retention === "short" || retention === "long"
    ? { minTokens, ttlMs: PROMPT_CACHE_TTL_MS[retention] }
    : undefined;
}
