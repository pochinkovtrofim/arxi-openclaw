import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderCreateOptions,
  type EmbeddingProviderCreateResult,
  type EmbeddingProviderIndexIdentity,
} from "openclaw/plugin-sdk/embedding-providers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
  LLAMA_CPP_PROVIDER_ID,
  resolveLlamaCppModelCacheDir,
} from "./defaults.js";
import { resolveLocalEmbeddingSchedule } from "./embedding-scheduler.js";
import { resolveManagedLlamaCppProviderConfig } from "./managed-provider-config.js";
import {
  inspectLlamaServerRuntime,
  type LlamaServerRuntimeFacts,
} from "./managed-server-inspection.js";
import {
  ensureLlamaCppModel,
  prepareManagedLlamaServer,
  reconcileManagedLlamaServer as reconcileLocalService,
} from "./managed-server.js";
import { resolveLlamaCppMediaModels } from "./media-config.js";

type AcquireLocalService = OpenClawPluginApi["runtime"]["llm"]["acquireLocalService"];
type LocalServiceAwareOptions = EmbeddingProviderCreateOptions & {
  acquireLocalService?: AcquireLocalService;
};

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
// A failed query lane serves nothing for this long; queries use the main model meanwhile.
const QUERY_LANE_RETRY_MS = 5 * 60_000;

function resolveProviderPort(provider: ModelProviderConfig): number {
  const port = Number(new URL(provider.baseUrl ?? "").port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Managed llama.cpp provider baseUrl must include a loopback port.");
  }
  return port;
}

async function prepareEmbeddingServer(
  options: EmbeddingProviderCreateOptions,
  embeddingSource: string,
): Promise<{ queryEmbeddingModel?: string }> {
  const provider = resolveManagedLlamaCppProviderConfig(options.config);
  const mediaModels = resolveLlamaCppMediaModels(provider);
  const cacheDir = resolveLlamaCppModelCacheDir(provider);
  const embeddingModelPath = await ensureLlamaCppModel({
    source: embeddingSource,
    cacheDir,
    download: true,
  });
  return await prepareManagedLlamaServer({
    chatModel: { mode: "preserve" },
    configuredChatModelIds: provider.models.map((model) => model.id),
    ...(mediaModels ? { mediaModels: [] } : {}),
    embeddingModelPath,
    port: resolveProviderPort(provider),
    reconcileBaseUrl: provider.baseUrl,
    localService: provider.localService,
  });
}

function wrapProvider(params: {
  provider: EmbeddingProvider;
  queryProvider?: EmbeddingProvider;
  canonicalModel: string;
  baseUrl: string;
}): EmbeddingProvider {
  let runtimeFacts: LlamaServerRuntimeFacts | undefined;
  let queryLaneRetryAt = 0;
  const embedQuery: EmbeddingProvider["embed"] = async (input, callOptions) => {
    const lane = params.queryProvider;
    if (lane && Date.now() >= queryLaneRetryAt) {
      try {
        return await lane.embed(input, callOptions);
      } catch (error) {
        if (callOptions?.signal?.aborted) {
          throw error;
        }
        // The lane only adds speed; an overlong query or a lane that cannot
        // load is answered by the main model, which accepts the full context.
        queryLaneRetryAt = Date.now() + QUERY_LANE_RETRY_MS;
      }
    }
    return await params.provider.embed(input, callOptions);
  };
  const schedule = resolveLocalEmbeddingSchedule(params.baseUrl);
  const refreshFacts = async (loadError?: string) => {
    runtimeFacts = await inspectLlamaServerRuntime({
      baseUrl: params.baseUrl,
      modelId: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      loadError,
    });
  };
  const withFacts = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      const value = await operation();
      await refreshFacts();
      return value;
    } catch (error) {
      await refreshFacts(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const wrapped: EmbeddingProvider = {
    id: "local",
    model: params.canonicalModel,
    dimensions: params.provider.dimensions,
    // Reserve BOS/EOS, a possible SentencePiece prefix, and the causal context boundary.
    maxInputTokens: params.provider.maxInputTokens ?? DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE - 4,
    embed: async (input, callOptions) =>
      await schedule.runQuery(
        async () => await withFacts(async () => await embedQuery(input, callOptions)),
      ),
    embedBatch: async (inputs, callOptions) =>
      await withFacts(
        async () =>
          await schedule.runIndexBatch(
            inputs,
            callOptions?.signal,
            async (slice) => await params.provider.embedBatch(slice, callOptions),
          ),
      ),
    close: params.provider.close,
  };
  Object.defineProperty(wrapped, LOCAL_EMBEDDING_RUNTIME_FACTS, {
    enumerable: false,
    value: () => runtimeFacts,
  });
  return wrapped;
}

export async function createLlamaCppEmbeddingProvider(
  options: EmbeddingProviderCreateOptions,
  embeddingSource: string,
  identity: EmbeddingProviderIndexIdentity,
): Promise<EmbeddingProviderCreateResult> {
  const server = await prepareEmbeddingServer(options, embeddingSource);
  const genericAdapter = getEmbeddingProvider("openai-compatible", options.config);
  if (!genericAdapter) {
    throw new Error("OpenAI-compatible embedding transport is unavailable.");
  }
  const acquireLocalService = (options as LocalServiceAwareOptions).acquireLocalService; // SAFETY: core runtime owns this injected option.
  const createTransport = async (model: string) =>
    await genericAdapter.create({
      ...options,
      provider: LLAMA_CPP_PROVIDER_ID,
      model,
      remote: undefined,
      ...(acquireLocalService
        ? {
            acquireLocalService: (...[target, signal]: Parameters<AcquireLocalService>) =>
              acquireLocalService({ ...target, reconcile: reconcileLocalService }, signal),
          }
        : {}),
    });
  const result = await createTransport(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID);
  if (!result.provider) {
    return result;
  }
  // Only a managed preset with room for a second model carries the query lane.
  const queryProvider = server?.queryEmbeddingModel
    ? (await createTransport(server.queryEmbeddingModel)).provider
    : undefined;
  return {
    provider: wrapProvider({
      provider: result.provider,
      ...(queryProvider ? { queryProvider } : {}),
      canonicalModel: identity.model,
      baseUrl: resolveManagedLlamaCppProviderConfig(options.config).baseUrl ?? "",
    }),
    runtime: {
      id: "local",
      inlineQueryTimeoutMs: 5 * 60_000,
      inlineBatchTimeoutMs: 10 * 60_000,
      cacheKeyData: identity.cacheKeyData,
      ...((identity.aliases?.length ?? 0) > 0 ? { indexIdentityAliases: identity.aliases } : {}),
    },
  };
}
