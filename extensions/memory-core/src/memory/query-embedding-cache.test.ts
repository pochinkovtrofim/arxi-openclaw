import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { readCachedQueryEmbedding, writeCachedQueryEmbedding } from "./query-embedding-cache.js";

function provider(): EmbeddingProvider {
  return {
    id: "mock",
    model: "mock-embed",
    embed: async () => [1, 0],
    embedBatch: async (texts) => texts.map(() => [1, 0]),
    close: async () => {},
  };
}

describe("query embedding cache", () => {
  it("returns copies per provider and never stores a zero vector", () => {
    const first = provider();
    writeCachedQueryEmbedding(first, "alpha", [0.6, 0.8]);
    writeCachedQueryEmbedding(first, "empty", [0, 0]);

    const cached = readCachedQueryEmbedding(first, "alpha");
    expect(cached).toEqual([0.6, 0.8]);
    cached?.fill(0);
    expect(readCachedQueryEmbedding(first, "alpha")).toEqual([0.6, 0.8]);
    expect(readCachedQueryEmbedding(first, "empty")).toBeUndefined();
    expect(readCachedQueryEmbedding(provider(), "alpha")).toBeUndefined();
  });

  it("evicts the least recently used query past its bound", () => {
    const owner = provider();
    for (let index = 0; index < 256; index += 1) {
      writeCachedQueryEmbedding(owner, `query ${index}`, [index + 1]);
    }
    expect(readCachedQueryEmbedding(owner, "query 0")).toEqual([1]);
    writeCachedQueryEmbedding(owner, "query 256", [257]);

    expect(readCachedQueryEmbedding(owner, "query 0")).toEqual([1]);
    expect(readCachedQueryEmbedding(owner, "query 1")).toBeUndefined();
    expect(readCachedQueryEmbedding(owner, "query 256")).toEqual([257]);
  });
});
