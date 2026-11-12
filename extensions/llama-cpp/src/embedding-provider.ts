import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES,
  LLAMA_CPP_PROVIDER_ID,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppEmbeddingModel,
  resolveLlamaCppModelCacheDir,
} from "./defaults.js";

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

function readIdentityLocalOptions(options: EmbeddingProviderCreateOptions) {
  const local = options.local ?? {};
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

function resolveModelIdentity(local: EmbeddingProviderCreateOptions["local"], dimensions?: number) {
  const embeddingModel = resolveLlamaCppEmbeddingModel(local);
  const model = embeddingModel.isDefault
    ? DEFAULT_LLAMA_CPP_EMBEDDING_MODEL
    : embeddingModel.source;
  const aliases = new Set<string>();
  if (embeddingModel.isDefault) {
    const currentDefaultPath = path.resolve(
      embeddingModel.cacheDir,
      DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
    );
    aliases.add(currentDefaultPath);
    const verifiedFile = resolveVerifiedDefaultFile(currentDefaultPath);
    if (verifiedFile) {
      aliases.add(verifiedFile);
    }
    aliases.add(
      path.resolve(resolveLegacyLlamaCppModelCacheDir(), DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
    );
    aliases.add(DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE);
    if (embeddingModel.source !== model) {
      aliases.add(embeddingModel.source);
    }
  }
  return {
    model,
    cacheKeyData: createCacheKeyData(model, dimensions),
    aliases: [...aliases].map((alias) => ({
      model: alias,
      cacheKeyData: createCacheKeyData(alias, dimensions),
    })),
  };
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
    const { createLlamaCppEmbeddingProvider } = await import("./embedding-provider.runtime.js");
    return createLlamaCppEmbeddingProvider(
      options,
      resolveLlamaCppEmbeddingModel(local).source,
      resolveModelIdentity(local, options.dimensions),
    );
  },
};
