import type { EmbeddingProvider } from "./embeddings.js";

// Background runs repeat the same recall queries, and a provider instance maps
// the same text to the same vector. Entries die with their provider.
const QUERY_EMBEDDING_CACHE_ENTRIES = 256;
const queryEmbeddingCache = new WeakMap<EmbeddingProvider, Map<string, readonly number[]>>();

export function readCachedQueryEmbedding(
  provider: EmbeddingProvider,
  text: string,
): number[] | undefined {
  const entries = queryEmbeddingCache.get(provider);
  const vector = entries?.get(text);
  if (!entries || !vector) {
    return undefined;
  }
  // Refresh recency: Map iteration order is insertion order.
  entries.delete(text);
  entries.set(text, vector);
  return [...vector];
}

export function writeCachedQueryEmbedding(
  provider: EmbeddingProvider,
  text: string,
  vector: readonly number[],
): void {
  // A zero vector marks a failed or empty embedding; never serve it again.
  if (!vector.some((value) => value !== 0)) {
    return;
  }
  let entries = queryEmbeddingCache.get(provider);
  if (!entries) {
    entries = new Map();
    queryEmbeddingCache.set(provider, entries);
  }
  entries.set(text, [...vector]);
  if (entries.size > QUERY_EMBEDDING_CACHE_ENTRIES) {
    entries.delete(entries.keys().next().value as string);
  }
}
