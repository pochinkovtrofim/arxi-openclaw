import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderAdapter,
  type EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES,
  LLAMA_CPP_PROVIDER_ID,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppEmbeddingModel,
  resolveLlamaCppModelCacheDir,
} from "./defaults.js";
import { selectLlamaServerAsset } from "./llama-server-install.js";
import { resolveManagedLlamaCppProviderConfig } from "./managed-provider-config.js";
import {
  ensureLlamaCppModel,
  inspectLlamaServerRuntime,
  prepareManagedLlamaServer,
  type LlamaServerRuntimeFacts,
} from "./managed-server.js";

type LlamaCppLocalOptions = {
  modelPath?: string;
  modelCacheDir?: string;
};

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
const preparedEmbeddingServers = new Map<string, Promise<void>>();
let verifiedDefaultFile: { fingerprint: string; path: string } | undefined;

function resolveVerifiedDefaultFile(cachePath: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const resolved = fs.realpathSync(cachePath);
    const stat = fs.statSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES)) {
      return undefined;
    }
    const fingerprint = [resolved, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(
      ":",
    );
    // Identity checks need a cold, synchronous answer. Hash once per exact file
    // generation; retargets and replacements must never reuse a verified alias.
    if (verifiedDefaultFile?.fingerprint === fingerprint) {
      return verifiedDefaultFile.path;
    }
    descriptor = fs.openSync(resolved, "r");
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      return undefined;
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let remaining = DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES;
    while (remaining > 0) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
      if (count === 0) {
        return undefined;
      }
      hash.update(buffer.subarray(0, count));
      remaining -= count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs ||
      fs.realpathSync(cachePath) !== resolved ||
      hash.digest("hex") !== DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256
    ) {
      return undefined;
    }
    verifiedDefaultFile = { fingerprint, path: resolved };
    return resolved;
  } catch {
    // Missing/unreadable/unverified weights get no compatibility alias. The
    // normal provider setup retains ownership of installation diagnostics.
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

type LlamaCppModelIdentity = {
  model: string;
  cacheKeyData: Record<string, unknown>;
  aliases: Array<{ model: string; cacheKeyData: Record<string, unknown> }>;
};

function readLocalOptions(options: { local?: unknown }): LlamaCppLocalOptions {
  return (options.local as LlamaCppLocalOptions | undefined) ?? {};
}

function readIdentityLocalOptions(options: EmbeddingProviderCreateOptions): LlamaCppLocalOptions {
  const local = readLocalOptions(options);
  const provider = options.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  return provider?.localService
    ? { ...local, modelCacheDir: resolveLlamaCppModelCacheDir(provider) }
    : local;
}

function createCacheKeyData(model: string, dimensions?: number): Record<string, unknown> {
  return {
    provider: "local",
    model,
    ...(typeof dimensions === "number" ? { outputDimensionality: dimensions } : {}),
  };
}

function resolveModelIdentity(
  local: LlamaCppLocalOptions,
  dimensions?: number,
): LlamaCppModelIdentity {
  const embeddingModel = resolveLlamaCppEmbeddingModel(local);
  const configuredCacheDir = embeddingModel.cacheDir;
  const currentDefaultPath = path.resolve(
    configuredCacheDir,
    DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  );
  const legacyDefaultPath = path.resolve(
    resolveLegacyLlamaCppModelCacheDir(),
    DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  );
  if (!embeddingModel.isDefault) {
    return {
      model: embeddingModel.source,
      cacheKeyData: createCacheKeyData(embeddingModel.source, dimensions),
      aliases: [],
    };
  }
  const aliases = new Set([
    currentDefaultPath,
    legacyDefaultPath,
    DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  ]);
  const verifiedFile = resolveVerifiedDefaultFile(currentDefaultPath);
  if (verifiedFile) {
    aliases.add(verifiedFile);
  }
  if (embeddingModel.source !== DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
    aliases.add(embeddingModel.source);
  }
  return {
    model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    cacheKeyData: createCacheKeyData(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, dimensions),
    aliases: [...aliases].map((model) => ({
      model,
      cacheKeyData: createCacheKeyData(model, dimensions),
    })),
  };
}

function resolveConfiguredProvider(options: EmbeddingProviderCreateOptions): ModelProviderConfig {
  return resolveManagedLlamaCppProviderConfig(options.config);
}

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
  embeddingModelIsDefault: boolean,
): Promise<void> {
  const provider = resolveConfiguredProvider(options);
  const cacheDir = resolveLlamaCppModelCacheDir(provider);
  const key = JSON.stringify([provider.baseUrl, embeddingSource, cacheDir]);
  const pending =
    preparedEmbeddingServers.get(key) ??
    (async () => {
      const embeddingModelPath = await ensureLlamaCppModel({
        source: embeddingSource,
        cacheDir,
        download: true,
      });
      await prepareManagedLlamaServer({
        chatModel: { mode: "preserve" },
        embeddingModelIsDefault,
        embeddingModelPath,
        port: resolveProviderPort(provider),
      });
    })();
  preparedEmbeddingServers.set(key, pending);
  try {
    await pending;
  } catch (error) {
    if (preparedEmbeddingServers.get(key) === pending) {
      preparedEmbeddingServers.delete(key);
    }
    throw error;
  }
}

function wrapProvider(params: {
  provider: EmbeddingProvider;
  canonicalModel: string;
  baseUrl: string;
}): EmbeddingProvider {
  let runtimeFacts: LlamaServerRuntimeFacts | undefined;
  const refreshFacts = async (loadError?: string) => {
    runtimeFacts = await inspectLlamaServerRuntime({
      baseUrl: params.baseUrl,
      modelId: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      backend: selectLlamaServerAsset().backend,
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
    maxInputTokens: params.provider.maxInputTokens,
    embed: async (input, callOptions) =>
      await withFacts(async () => await params.provider.embed(input, callOptions)),
    embedBatch: async (inputs, callOptions) =>
      await withFacts(async () => await params.provider.embedBatch(inputs, callOptions)),
    close: params.provider.close,
  };
  Object.defineProperty(wrapped, LOCAL_EMBEDDING_RUNTIME_FACTS, {
    enumerable: false,
    value: () => runtimeFacts,
  });
  return wrapped;
}

export const llamaCppEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: "local",
  defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  transport: "local",
  formatSetupError: (error) =>
    `Managed local embeddings are unavailable. Run \`openclaw configure\`, choose llama.cpp, and retry. ${error instanceof Error ? error.message : String(error)}`,
  resolveIndexIdentity: (options) => {
    const local = readIdentityLocalOptions(options);
    return resolveModelIdentity(local, options.dimensions);
  },
  create: async (options) => {
    const local = readIdentityLocalOptions(options);
    const embeddingModel = resolveLlamaCppEmbeddingModel(local);
    const identity = resolveModelIdentity(local, options.dimensions);
    await prepareEmbeddingServer(options, embeddingModel.source, embeddingModel.isDefault);
    const genericAdapter = getEmbeddingProvider("openai-compatible", options.config);
    if (!genericAdapter) {
      throw new Error("OpenAI-compatible embedding transport is unavailable.");
    }
    const result = await genericAdapter.create({
      ...options,
      provider: LLAMA_CPP_PROVIDER_ID,
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      remote: undefined,
    });
    if (!result.provider) {
      return result;
    }
    return {
      provider: wrapProvider({
        provider: result.provider,
        canonicalModel: identity.model,
        baseUrl: resolveConfiguredProvider(options).baseUrl ?? "",
      }),
      runtime: {
        id: "local",
        inlineQueryTimeoutMs: 5 * 60_000,
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: identity.cacheKeyData,
        ...(identity.aliases.length > 0 ? { indexIdentityAliases: identity.aliases } : {}),
      },
    };
  },
};
