import type { DatabaseSync, StatementSync } from "node:sqlite";
import { hashText, type MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import {
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { createMemoryChunkWriter, type IndexedMemoryChunk } from "./manager-chunk-writer.js";
import {
  markMemoryVectorRebuildRequired,
  memoryTableExists,
} from "./manager-vector-rebuild-state.js";
import { createMemoryVectorWriter } from "./manager-vector-write.js";

const MAX_VECTOR_POINT_DELETES = 32;

export type MemorySourceIndexReplacement = {
  entry: { path: string; hash: string; mtimeMs: number; size: number };
  chunks: IndexedMemoryChunk[];
  embeddings: number[][];
  model: string;
  now: number;
  vectorReady: boolean;
} & ({ source: "memory" } | { source: "sessions"; agentId: string; sessionId: string });

export type MemorySourceIndexHeader = Omit<MemorySourceIndexReplacement, "chunks" | "embeddings"> &
  ({ source: "memory" } | { source: "sessions"; agentId: string; sessionId: string });
export type MemorySourceIndexRow = { chunk: IndexedMemoryChunk; embedding: number[] };

type SourceIndexDatabase = {
  memory_index_sources: {
    path: string;
    source: MemorySource;
    hash: string;
    mtime: number;
    size: number;
  };
  memory_index_chunks: {
    id: string;
    path: string;
    source: MemorySource;
    start_line: number;
    end_line: number;
  };
};

type SourceIndexState = {
  vector: { enabled: boolean; available: boolean | null };
  fts: { enabled: boolean; available: boolean };
};

export function readMemorySourceHash(
  db: DatabaseSync,
  source: MemorySource,
  path: string,
): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<SourceIndexDatabase>(db)
      .selectFrom("memory_index_sources")
      .select("hash")
      .where("path", "=", path)
      .where("source", "=", source),
  )?.hash;
}

// The caller retains transaction admission and repeats file validation before
// each BEGIN attempt. This kernel runs only inside that admitted native transaction.
export class MemorySourceIndexKernel {
  constructor(
    private readonly database: DatabaseSync,
    private readonly state: SourceIndexState,
  ) {}

  replace(params: MemorySourceIndexReplacement): void {
    this.replaceRows(
      params,
      (function* () {
        for (const [index, chunk] of params.chunks.entries()) {
          yield { chunk, embedding: params.embeddings[index] ?? [] };
        }
      })(),
    );
  }

  replaceRows(params: MemorySourceIndexHeader, rows: Iterable<MemorySourceIndexRow>): void {
    const { entry, source, model, now, vectorReady } = params;
    this.clear(entry.path, source);
    let writeChunk: ReturnType<typeof createMemoryChunkWriter> | undefined;
    let writeVector: ReturnType<typeof createMemoryVectorWriter> | undefined;
    let ftsStatement: StatementSync | undefined;
    let hasEmbeddings = false;
    for (const { chunk, embedding } of rows) {
      hasEmbeddings ||= embedding.length > 0;
      const id = hashText(
        `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${model}`,
      );
      writeChunk ??= createMemoryChunkWriter(this.database, {
        path: entry.path,
        source,
        model,
        now,
      });
      writeChunk(id, chunk, embedding);
      if (vectorReady && embedding.length > 0) {
        writeVector ??= createMemoryVectorWriter(this.database, MEMORY_INDEX_VECTOR_TABLE);
        writeVector(id, embedding);
      }
      if (this.state.fts.enabled && this.state.fts.available) {
        ftsStatement ??= this.database.prepare(
          `INSERT INTO ${MEMORY_INDEX_FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
            ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        ftsStatement.run(chunk.text, id, entry.path, source, model, chunk.startLine, chunk.endLine);
      }
    }
    const db = getNodeSqliteKysely<SourceIndexDatabase>(this.database);
    executeSqliteQuerySync(
      this.database,
      db
        .insertInto("memory_index_sources")
        .values({
          path: entry.path,
          source,
          hash: entry.hash,
          mtime: entry.mtimeMs,
          size: entry.size,
        })
        .onConflict((conflict) =>
          conflict.columns(["path", "source"]).doUpdateSet((eb) => ({
            hash: eb.ref("excluded.hash"),
            mtime: eb.ref("excluded.mtime"),
            size: eb.ref("excluded.size"),
          })),
        ),
    );
    if (!vectorReady && hasEmbeddings) {
      markMemoryVectorRebuildRequired(this.database);
    }
  }

  deleteIfCurrent(params: {
    path: string;
    source: MemorySource;
    expectedHash: string | undefined;
    lineRanges?: Array<{ from: number; to: number }>;
  }): boolean {
    if (readMemorySourceHash(this.database, params.source, params.path) !== params.expectedHash) {
      return false;
    }
    if (params.lineRanges) {
      this.clearRegions(params.path, params.source, params.lineRanges);
      return true;
    }
    this.clear(params.path, params.source);
    executeSqliteQuerySync(
      this.database,
      getNodeSqliteKysely<SourceIndexDatabase>(this.database)
        .deleteFrom("memory_index_sources")
        .where("path", "=", params.path)
        .where("source", "=", params.source),
    );
    return true;
  }

  private clearRegions(
    pathname: string,
    source: MemorySource,
    ranges: Array<{ from: number; to: number }>,
  ): void {
    if (
      source !== "memory" ||
      !ranges.length ||
      ranges.length > 256 ||
      ranges.some(
        (range) =>
          !Number.isSafeInteger(range.from) ||
          !Number.isSafeInteger(range.to) ||
          range.from < 1 ||
          range.to < range.from,
      )
    ) {
      throw new Error("Memory source region deletion refused");
    }
    const chunks = this.database
      .prepare(
        "SELECT id,hash,start_line,end_line FROM memory_index_chunks WHERE path=? AND source=?",
      )
      // SAFETY: The owning chunk schema defines text IDs/hashes and integer start/end line columns.
      .all(pathname, source) as Array<{
      id: string;
      hash: string;
      start_line: number;
      end_line: number;
    }>;
    const selected = chunks.filter((chunk) =>
      ranges.some((range) => range.from <= chunk.end_line && range.to >= chunk.start_line),
    );
    // This runs in the existing owning publication transaction. A vector with
    // mixed content cannot remain eligible after one dependency was revoked.
    for (const chunk of selected) {
      if (memoryTableExists(this.database, MEMORY_INDEX_VECTOR_TABLE)) {
        if (!this.state.vector.enabled || this.state.vector.available !== true) {
          throw new Error("Memory source vector removal unavailable; keep purge pending");
        }
        this.database.prepare(`DELETE FROM ${MEMORY_INDEX_VECTOR_TABLE} WHERE id=?`).run(chunk.id);
      }
      if (memoryTableExists(this.database, MEMORY_INDEX_FTS_TABLE)) {
        this.database.prepare(`DELETE FROM ${MEMORY_INDEX_FTS_TABLE} WHERE id=?`).run(chunk.id);
      }
      this.database.prepare("DELETE FROM memory_index_chunks WHERE id=?").run(chunk.id);
      if (memoryTableExists(this.database, "memory_embedding_cache")) {
        this.database
          .prepare(
            "DELETE FROM memory_embedding_cache WHERE hash=? AND NOT EXISTS (SELECT 1 FROM memory_index_chunks WHERE hash=?)",
          )
          .run(chunk.hash, chunk.hash);
      }
    }
  }

  private clear(pathname: string, source: MemorySource): void {
    if (memoryTableExists(this.database, MEMORY_INDEX_VECTOR_TABLE)) {
      if (!this.state.vector.enabled || this.state.vector.available !== true) {
        markMemoryVectorRebuildRequired(this.database);
      } else {
        try {
          // Point lookups avoid scanning unrelated vectors for small sources;
          // larger batches use one scan to bound native calls. Keep either path
          // atomic before recording rebuild debt on a caught failure.
          runSqliteImmediateTransactionSync(this.database, () => {
            const rows = executeSqliteQuerySync(
              this.database,
              getNodeSqliteKysely<SourceIndexDatabase>(this.database)
                .selectFrom("memory_index_chunks")
                .select("id")
                .where("path", "=", pathname)
                .where("source", "=", source)
                .limit(MAX_VECTOR_POINT_DELETES + 1),
            ).rows;
            if (rows.length > MAX_VECTOR_POINT_DELETES) {
              this.database
                .prepare(
                  `DELETE FROM ${MEMORY_INDEX_VECTOR_TABLE} WHERE id IN (` +
                    "SELECT id FROM memory_index_chunks WHERE path = ? AND source = ?)",
                )
                .run(pathname, source);
              return;
            }
            const removeVector = this.database.prepare(
              `DELETE FROM ${MEMORY_INDEX_VECTOR_TABLE} WHERE id = ?`,
            );
            for (const { id } of rows) {
              removeVector.run(id);
            }
          });
        } catch {
          markMemoryVectorRebuildRequired(this.database);
        }
      }
    }
    if (this.state.fts.enabled && this.state.fts.available) {
      try {
        // Lexical search is model-agnostic; remove every model for this source.
        this.database
          .prepare(`DELETE FROM ${MEMORY_INDEX_FTS_TABLE} WHERE path = ? AND source = ?`)
          .run(pathname, source);
      } catch {}
    }
    executeSqliteQuerySync(
      this.database,
      getNodeSqliteKysely<SourceIndexDatabase>(this.database)
        .deleteFrom("memory_index_chunks")
        .where("path", "=", pathname)
        .where("source", "=", source),
    );
  }
}
