import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveCompactionMode } from "../agent-settings.js";
import { resolveModelExtraParamSources } from "../model-extra-params.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";

const DEFAULT_COLD_CACHE_COMPACTION_TOKENS = 150_000;
// Anthropic prompt-cache lifetimes for the "short" (5m) and "long" (1h) retentions.
const PROMPT_CACHE_TTL_MS = { short: 5 * 60_000, long: 60 * 60_000 } as const;

/**
 * Once a session's prompt cache has expired, its next request rewrites the whole history
 * at the cache-write rate. Compacting first makes that rewrite the summary instead.
 * `aheadMs` is the idle time at which background maintenance does that compaction instead,
 * a sixth of the lifetime before it ends, so a returning person never waits for it.
 */
export function resolveColdCacheCompaction(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
}): { minTokens: number; ttlMs: number; aheadMs: number } | undefined {
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
  if (retention !== "short" && retention !== "long") {
    return undefined;
  }
  const ttlMs = PROMPT_CACHE_TTL_MS[retention];
  return { minTokens, ttlMs, aheadMs: ttlMs - ttlMs / 6 };
}

/**
 * Safeguard hands compaction to the reply path's explicit preflight, which a cron run never
 * takes. A persistent cron session compacts at its own window, or earlier when its prompt
 * cache has expired since the last run.
 */
export function resolveAttemptCompactionPolicy(
  attempt: { trigger?: string; config?: OpenClawConfig; provider: string; modelId: string },
  agentId: string,
) {
  const { trigger, config: cfg, provider, modelId } = attempt;
  return trigger === "cron"
    ? {
        compactionMode: undefined,
        coldCache: resolveColdCacheCompaction({ cfg, provider, modelId, agentId }),
      }
    : { compactionMode: resolveEffectiveCompactionMode(cfg), coldCache: undefined };
}
