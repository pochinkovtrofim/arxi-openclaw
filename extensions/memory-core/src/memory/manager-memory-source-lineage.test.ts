import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../../../src/agents/admitted-run-context.js";
import {
  createTestAdmittedRunContext,
  withTestRunAdmission,
} from "../../../../src/agents/admitted-run-context.test-support.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "../../../../src/agents/memory-write-provenance.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../../../src/agents/tools/gateway-caller-context.js";
import { readMemoryArtifactProvenance } from "../../../../src/memory/memory-artifact-provenance.js";
import {
  clearMemoryArtifactSourceScope,
  registerMemoryArtifactSourceResolver,
  registerMemoryArtifactSourceScope,
  type MemoryArtifactSourceRef,
  type MemoryArtifactSourceStatus,
} from "../../../../src/memory/memory-artifact-source-authority.js";
import { resetPluginStateStoreForTests } from "../../../../src/plugin-state/plugin-state-store.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });
afterEach(() => resetPluginStateStoreForTests());

// Admission, writer, source lineage, filesystem, SQLite index and manager are
// real. Only the owning external source reader and optional embedding provider
// use the existing native test fixtures; these tests make no provider calls.
async function withSource(
  run: (source: {
    ref: MemoryArtifactSourceRef;
    setStatus: (status: MemoryArtifactSourceStatus) => void;
    delay: () => void;
    write: (
      relativePath: string,
      text: string,
      refs: readonly MemoryArtifactSourceRef[],
    ) => Promise<void>;
  }) => Promise<void>,
) {
  const ref = { ownerId: `fixture:${randomUUID()}`, value: "message:current-revision" };
  let status: MemoryArtifactSourceStatus = "current";
  let delayed = false;
  const dispose = registerMemoryArtifactSourceResolver(ref.ownerId, async (refs, { signal }) => {
    if (delayed) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) {
          finish();
        }
      });
    }
    return refs.map(() => status);
  });
  const write = async (
    relativePath: string,
    text: string,
    refs: readonly MemoryArtifactSourceRef[],
  ) => {
    const runId = randomUUID();
    await withTestRunAdmission(
      { runId, admittedRunContext: createTestAdmittedRunContext(runId) },
      async (admitted) => {
        const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: `agent:main:${runId}`,
        });
        if (!assertCurrent || !caller) {
          throw new Error("Native admitted caller unavailable");
        }
        registerMemoryArtifactSourceScope({
          runId,
          workspaceDir: fixture.paths.workspace,
          assertCurrent,
          refs,
          complete: true,
        });
        const writer = withMemoryWriteProvenance(
          {
            readFile: (file: string) => fs.readFile(file),
            writeFile: (file: string, content: string) => fs.writeFile(file, content),
          },
          createMemoryWriteProvenanceObserver({
            mutationRoot: fixture.paths.workspace,
            workspaceDir: fixture.paths.workspace,
            runId,
            resolveOriginClass: () => "agent",
          }),
        );
        try {
          await withGatewayToolCallerIdentity(caller, () =>
            writer.writeFile(path.join(fixture.paths.workspace, relativePath), text),
          );
        } finally {
          clearMemoryArtifactSourceScope(runId);
        }
      },
    );
  };
  try {
    await run({
      ref,
      write,
      setStatus: (value) => {
        status = value;
      },
      delay: () => {
        delayed = true;
      },
    });
  } finally {
    dispose();
  }
}

async function indexedManager(provider = "none") {
  const cfg = fixture.createConfig({ provider, sources: ["memory"], vectorEnabled: false });
  // Publish through the native CLI manager, then reopen that actual generation
  // with the read-only status owner to avoid implicit on-search reindexing.
  // Native watchers are already disabled by the shared fixture.
  const publisher = await fixture.getFreshManager(cfg, "cli");
  await publisher.sync({ reason: "source-lineage-fixture", force: true });
  await publisher.close();
  const manager = await fixture.getFreshManager(cfg, "status");
  expect(manager.status().fts?.available).toBe(true);
  return manager;
}

describe("native memory manager source lineage", () => {
  it("projects revoked readFile and final lexical results while preserving an unrelated indexed sibling", async () => {
    await withSource(async (source) => {
      await source.write("memory/derived.md", "Independent opening.\n", []);
      await source.write(
        "memory/derived.md",
        "Independent opening.\nVioletfragment derived appointment.\n",
        [source.ref],
      );
      await source.write("memory/sibling.md", "Violetfragment independent sibling.\n", []);
      const manager = await indexedManager();
      const db = Reflect.get(manager, "db") as DatabaseSync;
      const siblingRows = db
        .prepare("SELECT * FROM memory_index_chunks WHERE path=?")
        .all("memory/sibling.md");
      const derivedRows = db
        .prepare("SELECT * FROM memory_index_chunks WHERE path=?")
        .all("memory/derived.md");
      expect((await manager.readFile({ relPath: "memory/derived.md" })).text).toContain(
        "derived appointment",
      );
      expect(
        (await manager.search("violetfragment", { lexicalOnly: true })).map((row) => row.path),
      ).toContain("memory/derived.md");
      source.setStatus("revoked");
      const read = await manager.readFile({ relPath: "memory/derived.md", from: 2, lines: 1 });
      expect(read.text).not.toContain("derived appointment");
      expect(
        (await manager.search("violetfragment", { lexicalOnly: true })).map((row) => row.path),
      ).toEqual(["memory/sibling.md"]);
      expect(
        db.prepare("SELECT * FROM memory_index_chunks WHERE path=?").all("memory/sibling.md"),
      ).toEqual(siblingRows);
      expect(
        db.prepare("SELECT * FROM memory_index_chunks WHERE path=?").all("memory/derived.md"),
      ).toEqual(derivedRows);
      expect(await fs.readFile(path.join(fixture.paths.memory, "derived.md"), "utf8")).toContain(
        "derived appointment",
      );
    });
  });

  it("suppresses a cached hit whose indexed line offsets precede an admitted insertion", async () => {
    await withSource(async (source) => {
      await source.write("memory/offset.md", "Independent opening.\n", []);
      await source.write(
        "memory/offset.md",
        "Independent opening.\nVioletfragment derived appointment.\n",
        [source.ref],
      );
      const manager = await indexedManager();
      const db = Reflect.get(manager, "db") as DatabaseSync;
      const oldHeader = db
        .prepare("SELECT hash FROM memory_index_sources WHERE path=?")
        .get("memory/offset.md");
      expect(
        (await manager.search("violetfragment", { lexicalOnly: true })).map((row) => row.path),
      ).toContain("memory/offset.md");
      await source.write(
        "memory/offset.md",
        "New unrelated opening.\nIndependent opening.\nVioletfragment derived appointment.\n",
        [],
      );
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE path=?").get("memory/offset.md"),
      ).toEqual(oldHeader);
      source.setStatus("revoked");
      expect(await manager.search("violetfragment", { lexicalOnly: true })).toEqual([]);
      const record = await readMemoryArtifactProvenance({
        workspaceDir: fixture.paths.workspace,
        relativePath: "memory/offset.md",
      });
      expect(record?.sourceLineage?.regions).toEqual(
        expect.arrayContaining([expect.objectContaining({ from: 3, to: 3, tombstoned: true })]),
      );
      expect(await fs.readFile(path.join(fixture.paths.memory, "offset.md"), "utf8")).toContain(
        "New unrelated opening.",
      );
    });
  });

  it("holds a delayed reader inside the 900ms caller deadline without inventing revocation", async () => {
    await withSource(async (source) => {
      await source.write("memory/delayed.md", "Violetfragment derived appointment.\n", [
        source.ref,
      ]);
      const manager = await indexedManager();
      const address = { workspaceDir: fixture.paths.workspace, relativePath: "memory/delayed.md" };
      const before = await readMemoryArtifactProvenance(address);
      source.setStatus("revoked");
      source.delay();
      const started = Date.now();
      expect(
        (
          await manager.readFile({
            relPath: address.relativePath,
            signal: AbortSignal.timeout(900),
          })
        ).text,
      ).not.toContain("derived appointment");
      expect(Date.now() - started).toBeLessThan(1400);
      expect(await readMemoryArtifactProvenance(address)).toEqual(before);
      await expect(
        manager.search("violetfragment", { lexicalOnly: true, signal: AbortSignal.timeout(30) }),
      ).rejects.toThrow();
      expect(await readMemoryArtifactProvenance(address)).toEqual(before);
    });
  });

  it("filters actual hybrid partial and final recall after source revocation", async () => {
    await withSource(async (source) => {
      await source.write("memory/partial.md", "Alpha violetfragment derived appointment.\n", [
        source.ref,
      ]);
      await source.write("memory/sibling.md", "Alpha violetfragment independent sibling.\n", []);
      // provider=none intentionally never emits partial recall. The existing
      // embedding fixture enables the real native hybrid callback boundary.
      const manager = await indexedManager("mock");
      const before: string[][] = [];
      await manager.search("alpha violetfragment", {
        onPartialResults: (rows) => {
          if (rows) {
            before.push(rows.map((row) => row.path));
          }
        },
      });
      expect(before.flat()).toContain("memory/partial.md");
      source.setStatus("revoked");
      const partials: string[][] = [];
      const results = await manager.search("alpha violetfragment", {
        onPartialResults: (rows) => {
          if (rows) {
            partials.push(rows.map((row) => row.path));
          }
        },
      });
      expect(partials.length).toBeGreaterThan(0);
      expect(partials.flat()).not.toContain("memory/partial.md");
      expect(results.map((row) => row.path)).not.toContain("memory/partial.md");
      expect(results.map((row) => row.path)).toContain("memory/sibling.md");
    });
  });
});
