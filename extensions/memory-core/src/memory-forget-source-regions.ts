import path from "node:path";
import {
  hashText,
  loadSqliteVecExtension,
  readMemoryFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  prepareMemoryArtifactSourceForgetPlan,
  reconcileMemoryArtifactSourceForgetPlan,
  recordMemoryArtifactSourceForgetPending,
  recordMemoryArtifactWriteProvenance,
  tombstoneMemoryArtifactSources,
  withMemoryArtifactMutationQueue,
  type MemoryArtifactSourceForgetPlan,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  borrowOpenClawAgentDatabase,
  runSqliteImmediateTransactionSync,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { readMemoryPreimages } from "./dreaming-consolidation-artifacts.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import type { MemoryForgetReport } from "./memory-forget-report.js";
import { commitMemoryContent } from "./short-term-promotion-memory-write.js";

async function readFullMemory(
  workspaceDir: string,
  relativePath: string,
): Promise<string | undefined> {
  let content: string | undefined;
  await readMemoryFile({
    workspaceDir,
    relPath: relativePath,
    from: 1,
    lines: 1,
    projectContent: async (row) => {
      content = row.content;
      return row.content;
    },
  });
  return content;
}

function scrub(content: string, file: MemoryArtifactSourceForgetPlan["files"][number]): string {
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  if (
    hashText(content) !== file.fileHash ||
    file.regions.some(
      (region) =>
        region.to > lines.length ||
        hashText(lines.slice(region.from - 1, region.to).join("")) !== region.sha256,
    )
  ) {
    throw new Error("source_region_preimage_changed");
  }
  for (const region of file.regions) {
    for (let i = region.from - 1; i < region.to; i++) {
      const line = lines[i];
      if (line === undefined) {
        throw new Error("source_region_preimage_changed");
      }
      lines[i] = line.endsWith("\n") ? "\n" : "";
    }
  }
  const after = lines.join("");
  if (!file.afterHash || hashText(after) !== file.afterHash) {
    throw new Error("source_region_plan_unavailable");
  }
  return after;
}

/** Runs inside the existing workspace lock. No session/text heuristic selectors. */
export async function forgetMemorySourceRegions(params: {
  workspaceDir: string;
  agentId: string;
  sourceKeys: readonly string[];
  dryRun?: boolean;
}): Promise<MemoryForgetReport & { sourceKeys: string[]; pendingSources: string[] }> {
  let plan = await prepareMemoryArtifactSourceForgetPlan(params);
  const pending: string[] = [];
  const report = {
    agentId: params.agentId,
    dryRun: params.dryRun === true,
    sessionIds: [],
    participantMatches: [],
    sessionResolutions: [],
    entryKeys: [],
    mixedLineageEntryKeys: [],
    untargetableEntryKeys: [],
    curatedWrites: [],
    sourceKeys: plan.sourceKeys,
    // SAFETY: The fresh empty collection holds only source-key strings assigned below.
    pendingSources: [] as string[],
    refusals: pending,
    artifacts: {
      memoryFiles: 0,
      memoryEntries: 0,
      memoryLines: 0,
      sessionCorpusFiles: 0,
      sessionCorpusLines: 0,
      indexChunks: 0,
      indexSources: 0,
      ftsRows: 0,
      vectorRows: 0,
      embeddingCacheRows: 0,
      shortTermEntries: 0,
      seenHashScopes: 0,
      backups: 0,
      originRows: 0,
    },
  };
  if (!params.dryRun) {
    await tombstoneMemoryArtifactSources(params);
    const current = await reconcileMemoryArtifactSourceForgetPlan(params);
    plan = current.plan;
    pending.push(...current.pending);
  }
  const backups = await readMemoryPreimages(params.workspaceDir);
  let backupsChanged = false;
  for (const backup of backups) {
    const matching = plan.files.find(
      (file) =>
        file.fileHash === backup.value.contentHash || file.afterHash === backup.value.contentHash,
    );
    if (!matching || hashText(backup.value.content) !== backup.value.contentHash) {
      pending.push(`backup:${backup.value.contentHash}:unmapped_preimage`);
      continue;
    }
    if (matching.afterHash === backup.value.contentHash) {
      continue;
    }
    try {
      const content = scrub(backup.value.content, matching);
      report.artifacts.backups++;
      if (!params.dryRun) {
        backup.value = { ...backup.value, content, contentHash: hashText(content) };
        backupsChanged = true;
      }
    } catch {
      pending.push(`backup:${backup.value.contentHash}:preimage_changed`);
    }
  }
  if (backupsChanged) {
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
      workspaceDir: params.workspaceDir,
      entries: backups,
    });
  }
  for (const file of plan.files) {
    await withMemoryArtifactMutationQueue(
      path.join(params.workspaceDir, file.relativePath),
      async () => {
        let current: string | undefined;
        try {
          current = await readFullMemory(params.workspaceDir, file.relativePath);
        } catch {
          /* Retain scoped pending below. */
        }
        const afterHash = file.afterHash;
        if (
          current === undefined ||
          !afterHash ||
          (hashText(current) !== file.fileHash && hashText(current) !== afterHash)
        ) {
          pending.push(`file:${file.relativePath}:preimage_changed`);
          return;
        }
        const after = hashText(current) === afterHash ? current : scrub(current, file);
        const { db, release } = borrowOpenClawAgentDatabase({ agentId: params.agentId });
        try {
          const source = db
            .prepare("SELECT hash FROM memory_index_sources WHERE path=? AND source='memory'")
            // SAFETY: The owning schema stores hash as text; this SELECT returns that column or no row.
            .get(file.relativePath) as { hash: string } | undefined;
          if (source && source.hash !== file.fileHash && source.hash !== afterHash) {
            pending.push(`index:${file.relativePath}:snapshot_changed`);
            return;
          }
          const chunks = db
            .prepare(
              "SELECT id,hash,start_line,end_line FROM memory_index_chunks WHERE path=? AND source='memory'",
            )
            // SAFETY: These columns are text IDs/hashes and integer line bounds in the owning chunk schema.
            .all(file.relativePath) as Array<{
            id: string;
            hash: string;
            start_line: number;
            end_line: number;
          }>;
          if (!source && chunks.length) {
            pending.push(`index:${file.relativePath}:header_unavailable`);
            return;
          }
          const selected = chunks.filter((chunk) =>
            file.regions.some(
              (region) => region.from <= chunk.end_line && region.to >= chunk.start_line,
            ),
          );
          if (selected.length > 10000) {
            pending.push(`index:${file.relativePath}:needs_expansion`);
            return;
          }
          const vector = tableExists(db, "memory_index_chunks_vec");
          if (selected.length && vector && !(await loadSqliteVecExtension({ db })).ok) {
            pending.push(`index:${file.relativePath}:vector_unavailable`);
            return;
          }
          report.artifacts.indexChunks += selected.length;
          if (!params.dryRun) {
            runSqliteImmediateTransactionSync(db, () => {
              for (const chunk of selected) {
                if (vector) {
                  report.artifacts.vectorRows += Number(
                    db.prepare("DELETE FROM memory_index_chunks_vec WHERE id=?").run(chunk.id)
                      .changes,
                  );
                }
                if (tableExists(db, "memory_index_chunks_fts")) {
                  report.artifacts.ftsRows += Number(
                    db.prepare("DELETE FROM memory_index_chunks_fts WHERE id=?").run(chunk.id)
                      .changes,
                  );
                }
                db.prepare("DELETE FROM memory_index_chunks WHERE id=?").run(chunk.id);
                if (tableExists(db, "memory_embedding_cache")) {
                  report.artifacts.embeddingCacheRows += Number(
                    db
                      .prepare(
                        "DELETE FROM memory_embedding_cache WHERE hash=? AND NOT EXISTS (SELECT 1 FROM memory_index_chunks WHERE hash=?)",
                      )
                      .run(chunk.hash, chunk.hash).changes,
                  );
                }
              }
              if (source) {
                db.prepare(
                  "UPDATE memory_index_sources SET hash=? WHERE path=? AND source='memory'",
                ).run(afterHash, file.relativePath);
              }
              db.prepare("UPDATE memory_index_state SET revision=revision+1 WHERE id=1").run();
            });
            if (hashText(current) !== afterHash) {
              const rollback = await recordMemoryArtifactWriteProvenance({
                workspaceDir: params.workspaceDir,
                relativePath: file.relativePath,
                contentBefore: current,
                contentAfter: after,
                originClass: "agent",
                observedAt: Date.now(),
                sourceRefs: [],
              });
              try {
                await commitMemoryContent({
                  filePath: path.join(params.workspaceDir, file.relativePath),
                  tempPrefix: `${path.basename(file.relativePath)}.source-forget`,
                  expectedHash: file.fileHash,
                  expectedContent: current,
                  content: after,
                  conflictMessage: "Memory source preimage changed during forget",
                });
              } catch {
                await rollback?.();
                pending.push(`file:${file.relativePath}:commit_unavailable`);
                return;
              }
            }
            if (
              hashText((await readFullMemory(params.workspaceDir, file.relativePath)) ?? "") !==
              afterHash
            ) {
              pending.push(`file:${file.relativePath}:postcommit_changed`);
              return;
            }
          }
          report.artifacts.memoryFiles++;
          report.artifacts.memoryLines += file.regions.reduce(
            (count, region) => count + region.to - region.from + 1,
            0,
          );
        } catch {
          pending.push(`file:${file.relativePath}:cleanup_unavailable`);
        } finally {
          release();
        }
      },
    );
  }
  if (!params.dryRun) {
    const current = await reconcileMemoryArtifactSourceForgetPlan(params);
    pending.push(
      ...current.pending,
      ...current.addedPaths.map((relativePath) => `file:${relativePath}:discovered_after_cleanup`),
    );
  }
  if (pending.length) {
    report.pendingSources = plan.sourceKeys;
  }
  if (!params.dryRun) {
    await recordMemoryArtifactSourceForgetPending({ ...params, pending });
  }
  return report;
}
