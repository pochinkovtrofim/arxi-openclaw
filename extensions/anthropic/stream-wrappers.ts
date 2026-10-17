import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  getEnvApiKey,
  streamSimple,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveProviderEndpoint,
  supportsClaude1MContext,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyAnthropicPayloadPolicyToParams,
  composeProviderStreamWrappers,
  createAnthropicThinkingPrefillPayloadWrapper,
  createPayloadPatchStreamWrapper,
  isAnthropicOAuthApiKey,
  resolveAnthropicPayloadPolicy,
  resolveAnthropicServerCompactionPlan,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { createEmptyTransportUsage } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeFastMode,
  normalizeLowercaseStringOrEmpty,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeAnthropicServiceTier,
  resolveAnthropicFastModePlan,
  supportsAnthropicPriorityTier,
  type AnthropicServiceTier,
} from "./fast-mode-policy.js";

const log = createSubsystemLogger("anthropic-stream");

const ANTHROPIC_CONTEXT_1M_BETA_LEGACY = "context-1m-2025-08-07";
const ANTHROPIC_COMPACTION_BETA = "compact-2026-01-12";
const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_FAST_MODE_COST_MULTIPLIER = 2;
// Anthropic refuses speed=fast with 429 when the fast pool is limited or a subscription has no
// usage credits; skip fast for this long (or the server's Retry-After) instead of asking again.
const ANTHROPIC_FAST_MODE_REJECTION_COOLDOWN_MS = 10 * 60_000;
const ANTHROPIC_FAST_MODE_REJECTION_CODES = new Set(["400", "403", "429"]);
const OPENCLAW_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;
const OPENCLAW_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  ...OPENCLAW_DEFAULT_ANTHROPIC_BETAS,
] as const;

type DynamicFastMode = boolean | (() => boolean | undefined);

/** Publish installed-version evidence; the transport owns the floor and billing snapshot. */
export function createAnthropicClaudeCodeIdentityWrapper(
  baseStreamFn: StreamFn | undefined,
  resolveVersion: () => Promise<string | undefined>,
  sourceApi?: ProviderWrapStreamFnContext["sourceApi"],
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      model.provider !== "anthropic" ||
      (sourceApi ?? model.api) !== "anthropic-messages" ||
      !isAnthropicOAuthApiKey(options?.apiKey ?? getEnvApiKey(model.provider))
    ) {
      return underlying(model, context, options);
    }
    return resolveVersion().then((version) =>
      underlying(
        model,
        context,
        version
          ? { ...options, headers: { ...options?.headers, "user-agent": `claude-cli/${version}` } }
          : options,
      ),
    );
  };
}

function parseHeaderList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  betas: string[],
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === "anthropic-beta",
  );
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const values = Array.from(new Set([...existing, ...betas]));
  const key = existingKey ?? "anthropic-beta";
  merged[key] = values.join(",");
  return merged;
}

function applyAnthropicFastModePricing(model: Parameters<StreamFn>[0]): Parameters<StreamFn>[0] {
  const scaleRates = (rates: Parameters<StreamFn>[0]["cost"]) => ({
    input: rates.input * ANTHROPIC_FAST_MODE_COST_MULTIPLIER,
    output: rates.output * ANTHROPIC_FAST_MODE_COST_MULTIPLIER,
    cacheRead: rates.cacheRead * ANTHROPIC_FAST_MODE_COST_MULTIPLIER,
    cacheWrite: rates.cacheWrite * ANTHROPIC_FAST_MODE_COST_MULTIPLIER,
  });
  return {
    ...model,
    cost: {
      ...scaleRates(model.cost),
      ...(model.cost.tieredPricing
        ? {
            tieredPricing: model.cost.tieredPricing.map((tier) => ({
              ...tier,
              ...scaleRates(tier),
            })),
          }
        : {}),
    },
  };
}

function hasConfiguredAnthropicBeta(extraParams: Record<string, unknown> | undefined): boolean {
  const configured = extraParams?.anthropicBeta;
  if (typeof configured === "string") {
    return configured.trim().length > 0;
  }
  if (!Array.isArray(configured)) {
    return false;
  }
  return configured.some((beta) => typeof beta === "string" && beta.trim().length > 0);
}

export function resolveAnthropicBetas(
  extraParams: Record<string, unknown> | undefined,
  _modelId: string,
): string[] | undefined {
  const configured = extraParams?.anthropicBeta;
  const values =
    typeof configured === "string" ? [configured] : Array.isArray(configured) ? configured : [];
  const betas = new Set(values.flatMap(parseHeaderList));

  // Newer Claude 4.x 1M context is GA. Keep context1m as a context-sizing
  // opt-in, but do not send the retired beta even if it remains in older config.
  betas.delete(ANTHROPIC_CONTEXT_1M_BETA_LEGACY);

  return betas.size > 0 ? [...betas] : undefined;
}

export function createAnthropicBetaHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  betas: string[],
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const isOauth = isAnthropicOAuthApiKey(options?.apiKey);
    const effectiveBetas = betas.filter((beta) => beta !== ANTHROPIC_CONTEXT_1M_BETA_LEGACY);

    const openClawBetas = isOauth
      ? OPENCLAW_OAUTH_ANTHROPIC_BETAS
      : OPENCLAW_DEFAULT_ANTHROPIC_BETAS;
    const allBetas = [...new Set([...openClawBetas, ...effectiveBetas])];
    return underlying(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, allBetas),
    });
  };
}

export function createAnthropicFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: DynamicFastMode,
  extraParams?: Record<string, unknown>,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const fastPayloadWrapper = createPayloadPatchStreamWrapper(underlying, ({ payload }) => {
    delete payload.service_tier;
    payload.speed = "fast";
  });
  return (model, context, options) => {
    const resolved = typeof enabled === "function" ? enabled() : enabled;
    if (resolved === undefined) {
      return underlying(model, context, options);
    }
    const plan = resolveAnthropicFastModePlan({
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
      modelParams: model.params,
      params: extraParams,
      authMode: isAnthropicOAuthApiKey(options?.apiKey) ? "oauth" : "api_key",
      requestCapabilities: {
        endpointClass: resolveProviderEndpoint(model.baseUrl).endpointClass,
        allowsAnthropicServiceTier: resolveAnthropicPayloadPolicy({
          provider: model.provider,
          api: model.api,
          baseUrl: model.baseUrl,
        }).allowsServiceTier,
      },
    });
    if (plan === "native") {
      if (!resolved || Date.now() < (fastModeRejectedUntil.get(model.id) ?? 0)) {
        return underlying(model, context, options);
      }
      // A per-request beta header replaces the transport default, so OAuth keeps its own betas.
      const betas = isAnthropicOAuthApiKey(options?.apiKey)
        ? [...OPENCLAW_OAUTH_ANTHROPIC_BETAS, ANTHROPIC_FAST_MODE_BETA]
        : [ANTHROPIC_FAST_MODE_BETA];
      return createFastModeRejectionFallback(
        model,
        () =>
          fastPayloadWrapper(applyAnthropicFastModePricing(model), context, {
            ...options,
            headers: mergeAnthropicBetaHeader(options?.headers, betas),
          }),
        () => underlying(model, context, options),
      );
    }
    return plan === "service-tier"
      ? createAnthropicServiceTierWrapper(underlying, resolved ? "auto" : "standard_only")(
          model,
          context,
          options,
        )
      : underlying(model, context, options);
  };
}

const fastModeRejectedUntil = new Map<string, number>();

function readFastModeRejection(event: AssistantMessageEvent): number | undefined {
  if (event.type !== "error" || event.reason !== "error" || event.error.content.length > 0) {
    return undefined;
  }
  const code = event.error.errorCode ?? event.error.errorMessage?.match(/^(\d{3})\b/)?.[1];
  if (!code || !ANTHROPIC_FAST_MODE_REJECTION_CODES.has(code)) {
    return undefined;
  }
  const retryAfterSeconds = Number(event.error.errorMessage?.match(/Retry-After: (\d+)/)?.[1]);
  return retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : ANTHROPIC_FAST_MODE_REJECTION_COOLDOWN_MS;
}

/** Fast is an owner preference, not a requirement: a refused fast request reruns at standard speed. */
function createFastModeRejectionFallback(
  model: Parameters<StreamFn>[0],
  startFast: () => ReturnType<StreamFn>,
  startStandard: () => ReturnType<StreamFn>,
): ReturnType<StreamFn> {
  const output = createAssistantMessageEventStream();
  const fast = startFast();
  const pipe = async (
    source: ReturnType<StreamFn>,
    onFirstOutcome?: (event: AssistantMessageEvent) => boolean,
  ) => {
    const held: AssistantMessageEvent[] = [];
    let deciding = onFirstOutcome !== undefined;
    for await (const event of await source) {
      if (deciding && event.type === "start") {
        held.push(event);
        continue;
      }
      if (deciding) {
        deciding = false;
        if (onFirstOutcome?.(event)) {
          return false;
        }
        held.splice(0).forEach((heldEvent) => output.push(heldEvent));
      }
      output.push(event);
    }
    held.splice(0).forEach((heldEvent) => output.push(heldEvent));
    return true;
  };
  void (async () => {
    try {
      const finished = await pipe(fast, (event) => {
        const cooldownMs = readFastModeRejection(event);
        if (cooldownMs === undefined) {
          return false;
        }
        fastModeRejectedUntil.set(model.id, Date.now() + cooldownMs);
        log.warn(
          `fast mode refused for ${model.id} (${event.type === "error" ? event.error.errorMessage : ""}); ` +
            `using standard speed for ${Math.round(cooldownMs / 1000)}s`,
        );
        return true;
      });
      if (!finished) {
        await pipe(startStandard());
      }
    } catch (error) {
      output.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: createEmptyTransportUsage(),
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      });
    } finally {
      output.end();
    }
  })();
  return output;
}

function createAnthropicCompactionWrapper(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const compaction = resolveAnthropicServerCompactionPlan(
      model,
      extraParams,
      options?.apiKey ?? getEnvApiKey(model.provider),
    );
    if (!compaction.enabled) {
      return underlying(model, context, options);
    }
    const requestOptions = {
      ...options,
      anthropicServerCompaction: true,
      anthropicCompactThreshold: compaction.threshold,
      headers: mergeAnthropicBetaHeader(options?.headers, [ANTHROPIC_COMPACTION_BETA]),
    };
    return underlying(model, context, requestOptions);
  };
}

export function createAnthropicServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: AnthropicServiceTier,
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload, model }) => {
      const payloadPolicy = resolveAnthropicPayloadPolicy({
        provider: readStringValue(model.provider),
        api: readStringValue(model.api),
        baseUrl: readStringValue(model.baseUrl),
        serviceTier,
      });
      applyAnthropicPayloadPolicyToParams(payload, payloadPolicy, new Set());
    },
    {
      shouldPatch: ({ model, options }) => {
        // Opus 5 and Sonnet 5 do not support Priority Tier; omit service_tier entirely.
        if (isAnthropicOAuthApiKey(options?.apiKey) || !supportsAnthropicPriorityTier(model)) {
          return false;
        }
        return resolveAnthropicPayloadPolicy({
          provider: readStringValue(model.provider),
          api: readStringValue(model.api),
          baseUrl: readStringValue(model.baseUrl),
          serviceTier,
        }).allowsServiceTier;
      },
    },
  );
}

function createAnthropicThinkingPrefillWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn, (stripped) => {
    log.warn(
      `removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because Anthropic extended thinking requires conversations to end with a user turn`,
    );
  });
}

export function resolveAnthropicFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  const fastMode =
    typeof raw === "function"
      ? normalizeFastMode((raw as () => unknown)() as string | boolean | null | undefined)
      : normalizeFastMode(raw as string | boolean | null | undefined);
  return fastMode === "auto" ? undefined : fastMode === "ultrafast" ? true : fastMode;
}

export function resolveAnthropicServiceTier(
  extraParams: Record<string, unknown> | undefined,
): AnthropicServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  const normalized = normalizeAnthropicServiceTier(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid Anthropic service tier param: ${rawSummary}`);
  }
  return normalized;
}

export function wrapAnthropicProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  const anthropicBetas = resolveAnthropicBetas(ctx.extraParams, ctx.modelId);
  const needsAnthropicBetaWrapper =
    anthropicBetas !== undefined ||
    hasConfiguredAnthropicBeta(ctx.extraParams) ||
    (ctx.extraParams?.context1m === true && supportsClaude1MContext({ id: ctx.modelId }));
  const serviceTier = resolveAnthropicServiceTier(ctx.extraParams);
  const hasFastModeParam =
    ctx.extraParams !== undefined &&
    (Object.hasOwn(ctx.extraParams, "fastMode") || Object.hasOwn(ctx.extraParams, "fast_mode"));
  return composeProviderStreamWrappers(
    ctx.streamFn,
    needsAnthropicBetaWrapper
      ? (streamFn) => createAnthropicBetaHeadersWrapper(streamFn, anthropicBetas ?? [])
      : undefined,
    serviceTier
      ? (streamFn) => createAnthropicServiceTierWrapper(streamFn, serviceTier)
      : undefined,
    hasFastModeParam
      ? (streamFn) =>
          createAnthropicFastModeWrapper(
            streamFn,
            () => resolveAnthropicFastMode(ctx.extraParams),
            ctx.extraParams,
          )
      : undefined,
    // The shared plan owns the default, opt-out, and per-request auth/route gates.
    (streamFn) => createAnthropicCompactionWrapper(streamFn, ctx.extraParams),
    createAnthropicThinkingPrefillWrapper,
  );
}
