import { extractErrorCode, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  attemptMemoryCorpus,
  composeMemoryCorpusMetadata,
  readMemoryCorpusSupplements,
  runMemoryCorpusDeadline,
  type MemoryCorpusAttempt,
} from "./memory-corpus.js";

// Search and the first source reads form one operation. Only returned memory
// hits are expanded; session/wiki references keep their own visibility path.
export async function readMemorySearchSources(params: {
  results: readonly MemorySearchResult[];
  read: (request: { relPath: string; from: number; lines: number }) => Promise<MemoryReadResult>;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  const seen = new Set<string>();
  const hits = params.results
    .filter((hit) => {
      if (hit.source !== "memory" || seen.has(hit.path)) {
        return false;
      }
      seen.add(hit.path);
      return true;
    })
    .slice(0, 3);
  const reads = await Promise.all(
    hits.map(async (hit) => {
      const from = Math.max(1, hit.startLine - 2);
      const lines = Math.min(24, Math.max(1, hit.endLine - from + 3));
      try {
        const result = await params.read({ relPath: hit.path, from, lines });
        if (result.status !== "ok" || result.text.length <= 2_000) {
          return result;
        }
        const text = result.text.slice(0, 2_000);
        const count = text.split("\n").length;
        result.text = text;
        result.lines = count;
        result.truncated = true;
        result.nextFrom = (result.from ?? from) + count - 1;
        return result;
      } catch (error) {
        return {
          path: hit.path,
          status: "error" as const,
          text: "",
          code: extractErrorCode(error) ?? "MEMORY_READ_FAILED",
        };
      }
    }),
  );
  params.signal?.throwIfAborted();
  return reads;
}

type MemoryReadRequest = {
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  signal?: AbortSignal;
};

function readWiki(params: MemoryReadRequest, signal: AbortSignal) {
  return readMemoryCorpusSupplements({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    signal,
  });
}

function attemptValue<T>(attempt: MemoryCorpusAttempt<T>): T | null {
  return attempt.outcome === "not-registered" ? null : attempt.value;
}

export async function executeWikiMemoryReadResult(params: MemoryReadRequest) {
  return await runMemoryCorpusDeadline({
    operation: "memory_get",
    parentSignal: params.signal,
    run: async (signal) => {
      const wiki = await readWiki(params, signal);
      const result =
        attemptValue(wiki) ??
        (wiki.outcome === "ok"
          ? { status: "not_found" as const, path: params.relPath, text: "" as const }
          : { path: params.relPath, text: "" });
      return jsonResult({ ...result, ...composeMemoryCorpusMetadata([wiki]) });
    },
  });
}

export async function executeMemoryReadResult(
  params: MemoryReadRequest & { read: () => Promise<MemoryReadResult> },
) {
  if (params.requestedCorpus !== "all") {
    try {
      return jsonResult(await params.read());
    } catch (error) {
      return jsonResult({
        path: params.relPath,
        text: "",
        status: "error",
        code: extractErrorCode(error) ?? "MEMORY_READ_FAILED",
        error: formatErrorMessage(error),
      });
    }
  }
  return await runMemoryCorpusDeadline({
    operation: "memory_get",
    parentSignal: params.signal,
    run: async (signal) => {
      const [memory, wiki] = await Promise.all([
        attemptMemoryCorpus({
          corpus: "memory",
          signal,
          unavailableValue: null,
          run: params.read,
        }),
        readWiki(params, signal),
      ]);
      const memoryResult = attemptValue(memory);
      const wikiResult = attemptValue(wiki);
      const result =
        memoryResult?.status !== "not_found" && memoryResult !== null
          ? memoryResult
          : (wikiResult ??
            (memory.outcome === "ok" || wiki.outcome === "ok"
              ? { status: "not_found" as const, path: params.relPath, text: "" as const }
              : { status: "error", path: params.relPath, text: "" }));
      return jsonResult({ ...result, ...composeMemoryCorpusMetadata([memory, wiki]) });
    },
  });
}
