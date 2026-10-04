import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { describe, expect, it } from "vitest";
import { readMemorySearchSources } from "./memory-read-tool.js";

function hit(path: string, source: "memory" | "sessions" = "memory"): MemorySearchResult {
  return { path, source, startLine: 10, endLine: 12, score: 0.9, snippet: "old indexed text" };
}

describe("search with current memory sources", () => {
  it("reads bounded unique memory hits concurrently and preserves their ranked order", async () => {
    const requests: Array<{ relPath: string; from: number; lines: number }> = [];
    const pending = new Map<string, ReturnType<typeof createDeferred<MemoryReadResult>>>();
    const work = readMemorySearchSources({
      results: [
        hit("session", "sessions"),
        hit("memory/a.md"),
        hit("memory/a.md"),
        hit("memory/b.md"),
        hit("memory/c.md"),
        hit("memory/unused.md"),
      ],
      read: (request) => {
        requests.push(request);
        const deferred = createDeferred<MemoryReadResult>();
        pending.set(request.relPath, deferred);
        return deferred.promise;
      },
    });
    expect(requests.map((request) => request.relPath)).toEqual([
      "memory/a.md",
      "memory/b.md",
      "memory/c.md",
    ]);
    expect(requests.every((request) => request.from > 0 && request.lines <= 24)).toBe(true);
    for (const path of ["memory/c.md", "memory/b.md", "memory/a.md"]) {
      pending.get(path)!.resolve({ status: "ok", path, text: `current ${path}` });
    }
    const reads = await work;
    expect(reads.map((read) => read.text)).toEqual([
      "current memory/a.md",
      "current memory/b.md",
      "current memory/c.md",
    ]);
    expect(JSON.stringify(reads)).not.toContain("old indexed text");
  });

  it("reports missing and denied reads without presenting the indexed snippet as current", async () => {
    const reads = await readMemorySearchSources({
      results: [hit("memory/missing.md"), hit("memory/denied.md"), hit("memory/large.md")],
      read: async ({ relPath, from }) => {
        if (relPath.endsWith("missing.md")) {
          return { status: "not_found", path: relPath, text: "" };
        }
        if (relPath.endsWith("denied.md")) {
          throw Object.assign(new Error("private failure detail"), {
            code: "MEMORY_PATH_NOT_ALLOWED",
          });
        }
        return { status: "ok", path: relPath, from, lines: 1, text: "x".repeat(10_000) };
      },
    });
    expect(reads[0]).toMatchObject({ status: "not_found", text: "" });
    expect(reads[1]).toMatchObject({ status: "error", text: "", code: "MEMORY_PATH_NOT_ALLOWED" });
    expect(reads[2]).toMatchObject({ status: "ok", truncated: true });
    expect(reads[2]!.text).toHaveLength(2_000);
    expect(JSON.stringify(reads)).not.toMatch(/old indexed text|private failure detail/);
  });

  it("does not return a source read after the caller is cancelled", async () => {
    const abort = new AbortController();
    const pending = createDeferred<MemoryReadResult>();
    const work = readMemorySearchSources({
      results: [hit("memory/a.md")],
      read: () => pending.promise,
      signal: abort.signal,
    });
    abort.abort(new Error("cancelled"));
    pending.resolve({ status: "ok", path: "memory/a.md", text: "private source" });
    await expect(work).rejects.toThrow("cancelled");
  });
});
