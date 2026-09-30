import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  hashText,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  prepareMemoryArtifactSourceForgetPlan,
  projectMemoryArtifactSourceContent,
  readForgottenMemoryArtifactSources,
  readMemoryArtifactProvenance,
  recordMemoryArtifactWriteProvenance,
  registerMemoryArtifactSourceResolver,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../../src/agents/admitted-run-context.js";
import {
  createTestAdmittedRunContext,
  withTestRunAdmission,
} from "../../../src/agents/admitted-run-context.test-support.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "../../../src/agents/memory-write-provenance.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../../src/agents/tools/gateway-caller-context.js";
import {
  clearMemoryArtifactSourceScope,
  registerMemoryArtifactSourceScope,
} from "../../../src/memory/memory-artifact-source-authority.js";
import { readMemoryPreimages } from "./dreaming-consolidation-artifacts.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { createMemoryForgetFixture } from "./memory-forget.test-helpers.js";

describe("native exact source forget", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let dispose: () => void;
  let sourceKey: string;
  let status: "current" | "unavailable";
  const original = "Independent preference.\nDerived private appointment.\nIndependent note.\n";
  const scrubbed = "Independent preference.\n\nIndependent note.\n";
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("openclaw-memory-source-forget-");
    status = "current";
    dispose = registerMemoryArtifactSourceResolver("fixture:source-forget", async (refs) =>
      refs.map(() => status),
    );
    const file = path.join(fixture.workspaceDir, "MEMORY.md");
    await fs.writeFile(file, "Independent preference.\n");
    await recordMemoryArtifactWriteProvenance({
      workspaceDir: fixture.workspaceDir,
      relativePath: "MEMORY.md",
      contentBefore: "",
      contentAfter: "Independent preference.\n",
      originClass: "agent",
      observedAt: 1,
    });
    await fs.writeFile(file, "Independent preference.\nDerived private appointment.\n");
    await recordMemoryArtifactWriteProvenance({
      workspaceDir: fixture.workspaceDir,
      relativePath: "MEMORY.md",
      contentBefore: "Independent preference.\n",
      contentAfter: "Independent preference.\nDerived private appointment.\n",
      originClass: "agent",
      observedAt: 2,
      sourceRefs: [{ ownerId: "fixture:source-forget", value: "opaque-revision-1" }],
    });
    await fs.writeFile(file, original);
    await recordMemoryArtifactWriteProvenance({
      workspaceDir: fixture.workspaceDir,
      relativePath: "MEMORY.md",
      contentBefore: "Independent preference.\nDerived private appointment.\n",
      contentAfter: original,
      originClass: "agent",
      observedAt: 3,
    });
    sourceKey = Object.keys(
      (
        await readMemoryArtifactProvenance({
          workspaceDir: fixture.workspaceDir,
          relativePath: "MEMORY.md",
        })
      )?.sourceLineage?.sources ?? {},
    )[0]!;
    expect(sourceKey).toMatch(/^[a-f0-9]{64}$/u);
  });

  afterEach(async () => {
    dispose();
    await fixture.cleanup();
  });

  const forget = (dryRun = false) =>
    forgetMemoryEntries({ cfg: fixture.cfg, agentId: "main", sourceKeys: [sourceKey], dryRun });
  const backup = async (content: string) =>
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
      workspaceDir: fixture.workspaceDir,
      entries: [
        {
          key: "native-preimage",
          value: { createdAt: "2026-09-30T00:00:00Z", content, contentHash: sha(content) },
        },
      ],
    });

  const admittedWrite = async (
    relativePath: string,
    content: string,
    beforePhysicalWrite?: () => Promise<void>,
  ) => {
    await fs.mkdir(path.dirname(path.join(fixture.workspaceDir, relativePath)), {
      recursive: true,
    });
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
          throw new Error("Native admitted writer unavailable");
        }
        registerMemoryArtifactSourceScope({
          runId,
          workspaceDir: fixture.workspaceDir,
          assertCurrent,
          complete: true,
          refs: [{ ownerId: "fixture:source-forget", value: "opaque-revision-1" }],
        });
        const writer = withMemoryWriteProvenance(
          {
            readFile: (file: string) => fs.readFile(file),
            writeFile: async (file: string, text: string) => {
              await beforePhysicalWrite?.();
              await fs.writeFile(file, text);
            },
          },
          createMemoryWriteProvenanceObserver({
            mutationRoot: fixture.workspaceDir,
            workspaceDir: fixture.workspaceDir,
            runId,
            resolveOriginClass: () => "agent",
          }),
        );
        try {
          await withGatewayToolCallerIdentity(caller, () =>
            writer.writeFile(path.join(fixture.workspaceDir, relativePath), content),
          );
        } finally {
          clearMemoryArtifactSourceScope(runId);
        }
      },
    );
  };

  it("previews without source tombstones or physical writes", async () => {
    expect(await forget(true)).toMatchObject({
      dryRun: true,
      sourceKeys: [sourceKey],
      pendingSources: [],
    });
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toBe(original);
    expect(
      await readForgottenMemoryArtifactSources({
        workspaceDir: fixture.workspaceDir,
        sourceKeys: [sourceKey],
      }),
    ).toEqual(new Set());
  });

  it("physically removes selected native file/index/vector/cache/backup bytes and preserves unrelated rows", async () => {
    await backup(original);
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    expect((await loadSqliteVecExtension({ db })).ok).toBe(true);
    db.exec(
      "CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(text,id UNINDEXED,path UNINDEXED,source UNINDEXED,model UNINDEXED,start_line UNINDEXED,end_line UNINDEXED); CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2]);",
    );
    db.prepare(
      "INSERT INTO memory_index_sources(path,source,hash,mtime,size) VALUES ('MEMORY.md','memory',?,1,1)",
    ).run(sha(original));
    db.prepare(
      "INSERT INTO memory_index_sources(path,source,hash,mtime,size) VALUES ('memory/sibling.md','memory','sibling',1,1)",
    ).run();
    for (const [id, line, text, file] of [
      ["keep", 1, "Independent preference.", "MEMORY.md"],
      ["erase", 2, "Derived private appointment.", "MEMORY.md"],
      ["keep-note", 3, "Independent note.", "MEMORY.md"],
      ["sibling", 1, "Unrelated sibling.", "memory/sibling.md"],
    ] as const) {
      db.prepare(
        "INSERT INTO memory_index_chunks(id,path,source,start_line,end_line,hash,model,text,embedding,updated_at) VALUES (?,?,'memory',?,?,?,'test',?,'[1,0]',1)",
      ).run(id, file, line, line, sha(text), text);
      db.prepare(
        "INSERT INTO memory_index_chunks_fts(text,id,path,source,model,start_line,end_line) VALUES (?,?,?,'memory','test',?,?)",
      ).run(text, id, file, line, line);
      db.prepare("INSERT INTO memory_index_chunks_vec(id,embedding) VALUES (?,?)").run(
        id,
        new Float32Array([1, 0]),
      );
      db.prepare(
        "INSERT INTO memory_embedding_cache(provider,model,provider_key,hash,embedding,dims,updated_at) VALUES ('test','test','test',?,'[1,0]',2,1)",
      ).run(sha(text));
    }
    const kept = db
      .prepare("SELECT * FROM memory_index_chunks WHERE id<>'erase' ORDER BY id")
      .all();
    expect(await forget()).toMatchObject({
      pendingSources: [],
      refusals: [],
      artifacts: { indexChunks: 1, vectorRows: 1, ftsRows: 1, embeddingCacheRows: 1, backups: 1 },
    });
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toBe(scrubbed);
    expect(db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all()).toEqual(kept);
    for (const table of ["memory_index_chunks_fts", "memory_index_chunks_vec"]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE id='erase'`).get()).toEqual({
        n: 0,
      });
    }
    expect(
      db
        .prepare("SELECT count(*) AS n FROM memory_embedding_cache WHERE hash=?")
        .get(sha("Derived private appointment.")),
    ).toEqual({ n: 0 });
    expect((await readMemoryPreimages(fixture.workspaceDir))[0].value.content).toBe(scrubbed);
    const plan = await prepareMemoryArtifactSourceForgetPlan({
      workspaceDir: fixture.workspaceDir,
      sourceKeys: [sourceKey],
    });
    expect(JSON.stringify(plan)).not.toContain("Derived private appointment");
    expect(plan.files[0]).toMatchObject({ fileHash: sha(original), afterHash: sha(scrubbed) });
  });

  it("retains an immutable original plan after a manual conflict and completes once exact preimage is restored", async () => {
    const file = path.join(fixture.workspaceDir, "MEMORY.md");
    await fs.writeFile(file, "Manual independent revision.\n");
    expect(await forget()).toMatchObject({ pendingSources: [sourceKey] });
    expect(await fs.readFile(file, "utf8")).toBe("Manual independent revision.\n");
    const before = await prepareMemoryArtifactSourceForgetPlan({
      workspaceDir: fixture.workspaceDir,
      sourceKeys: [sourceKey],
    });
    expect(before.files[0].fileHash).toBe(sha(original));
    await fs.writeFile(file, original);
    expect(await forget()).toMatchObject({ pendingSources: [], refusals: [] });
    expect(await fs.readFile(file, "utf8")).toBe(scrubbed);
  });

  it("keeps ambiguous backups pending on retry after the primary file lineage has been removed", async () => {
    const ambiguous = "Older preimage.\nDerived private appointment.\n";
    await backup(ambiguous);
    expect(await forget()).toMatchObject({ pendingSources: [sourceKey] });
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toBe(scrubbed);
    expect(await forget()).toMatchObject({
      pendingSources: [sourceKey],
      refusals: [`backup:${sha(ambiguous)}:unmapped_preimage`],
    });
    expect((await readMemoryPreimages(fixture.workspaceDir))[0].value.content).toBe(ambiguous);
    expect(
      (
        await prepareMemoryArtifactSourceForgetPlan({
          workspaceDir: fixture.workspaceDir,
          sourceKeys: [sourceKey],
        })
      ).files[0].fileHash,
    ).toBe(sha(original));
  });

  it("holds an unavailable source reversibly until explicit native forget, rather than treating unavailable as revoke", async () => {
    status = "unavailable";
    expect(
      await projectMemoryArtifactSourceContent({
        workspaceDir: fixture.workspaceDir,
        relativePath: "MEMORY.md",
        content: original,
      }),
    ).toMatchObject({ status: "held", tombstonedRegions: [] });
    status = "current";
    expect(
      await projectMemoryArtifactSourceContent({
        workspaceDir: fixture.workspaceDir,
        relativePath: "MEMORY.md",
        content: original,
      }),
    ).toMatchObject({ status: "current", content: original });
    await forget();
    expect(
      await readForgottenMemoryArtifactSources({
        workspaceDir: fixture.workspaceDir,
        sourceKeys: [sourceKey],
      }),
    ).toEqual(new Set([sourceKey]));
  });

  it("retains index mismatch evidence after the primary file is already clean and completes only an exact snapshot retry", async () => {
    await forget();
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare(
      "INSERT INTO memory_index_sources(path,source,hash,mtime,size) VALUES ('MEMORY.md','memory','unknown-snapshot',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO memory_index_chunks(id,path,source,start_line,end_line,hash,model,text,embedding,updated_at) VALUES ('old-derived','MEMORY.md','memory',2,2,'old-hash','test','Derived private appointment.','[]',1)",
    ).run();
    expect(await forget()).toMatchObject({
      pendingSources: [sourceKey],
      refusals: ["index:MEMORY.md:snapshot_changed"],
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE id='old-derived'").get(),
    ).toEqual({ n: 1 });
    expect(
      (
        await prepareMemoryArtifactSourceForgetPlan({
          workspaceDir: fixture.workspaceDir,
          sourceKeys: [sourceKey],
        })
      ).files[0].fileHash,
    ).toBe(sha(original));
    db.prepare(
      "UPDATE memory_index_sources SET hash=? WHERE path='MEMORY.md' AND source='memory'",
    ).run(sha(original));
    expect(await forget()).toMatchObject({ pendingSources: [], refusals: [] });
    expect(
      db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE id='old-derived'").get(),
    ).toEqual({ n: 0 });
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toBe(scrubbed);
  });

  it("captures a genuine newly admitted file after the original plan without replacing its original hashes", async () => {
    const initial = await prepareMemoryArtifactSourceForgetPlan({
      workspaceDir: fixture.workspaceDir,
      sourceKeys: [sourceKey],
    });
    const derived = "Newly copied private appointment.\n";
    await admittedWrite("memory/new-derived.md", derived);
    expect(await forget()).toMatchObject({ pendingSources: [], refusals: [] });
    expect(
      await fs.readFile(path.join(fixture.workspaceDir, "memory/new-derived.md"), "utf8"),
    ).toBe("\n");
    const plan = await prepareMemoryArtifactSourceForgetPlan({
      workspaceDir: fixture.workspaceDir,
      sourceKeys: [sourceKey],
    });
    expect(plan.files.find((file) => file.relativePath === "MEMORY.md")).toEqual(initial.files[0]);
    expect(plan.files.find((file) => file.relativePath === "memory/new-derived.md")).toMatchObject({
      fileHash: sha(derived),
      afterHash: sha("\n"),
    });
  });

  it("keeps a newly admitted same-path preimage pending instead of replacing immutable region proof", async () => {
    const initial = await prepareMemoryArtifactSourceForgetPlan({
      workspaceDir: fixture.workspaceDir,
      sourceKeys: [sourceKey],
    });
    const changed = `${original}Another derived appointment.\n`;
    await admittedWrite("MEMORY.md", changed);
    const result = await forget();
    expect(result.pendingSources).toEqual([sourceKey]);
    expect(result.refusals).toContain("file:MEMORY.md:unplanned_native_preimage");
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toBe(changed);
    expect(
      (
        await prepareMemoryArtifactSourceForgetPlan({
          workspaceDir: fixture.workspaceDir,
          sourceKeys: [sourceKey],
        })
      ).files[0],
    ).toEqual(initial.files[0]);
  });

  it("reports a delayed admitted physical commit pending and safely completes its exact-preimage retry", async ({
    signal,
  }) => {
    await prepareMemoryArtifactSourceForgetPlan({
      workspaceDir: fixture.workspaceDir,
      sourceKeys: [sourceKey],
    });
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = () => release();
    signal.addEventListener("abort", abort, { once: true });
    const text = "Delayed copied private appointment.\n";
    const writing = admittedWrite("memory/delayed-derived.md", text, async () => {
      entered();
      await gate;
    });
    try {
      await Promise.race([
        ready,
        writing.then(() => {
          throw new Error("Native writer missed the physical-commit barrier");
        }),
      ]);
      const result = await forget();
      expect(result.pendingSources).toEqual([sourceKey]);
      expect(result.refusals).toContain("file:memory/delayed-derived.md:preimage_changed");
      release();
      await writing;
      expect(
        await fs.readFile(path.join(fixture.workspaceDir, "memory/delayed-derived.md"), "utf8"),
      ).toBe(text);
      expect(await forget()).toMatchObject({ pendingSources: [], refusals: [] });
      expect(
        await fs.readFile(path.join(fixture.workspaceDir, "memory/delayed-derived.md"), "utf8"),
      ).toBe("\n");
    } finally {
      signal.removeEventListener("abort", abort);
      release();
      await writing.catch(() => undefined);
    }
  });

  it("refuses unknown or mixed selectors without broad native deletion", async () => {
    await expect(
      forgetMemoryEntries({ cfg: fixture.cfg, agentId: "main", sourceKeys: ["f".repeat(64)] }),
    ).rejects.toThrow("no native lineage");
    await expect(
      forgetMemoryEntries({
        cfg: fixture.cfg,
        agentId: "main",
        sourceKeys: [sourceKey],
        sessionIds: ["other"],
      }),
    ).rejects.toThrow("cannot be combined");
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toBe(original);
    expect(hashText(original)).toBe(sha(original));
  });
});
