import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { FsSafeError, root } from "../../infra/fs-safe.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { memoryArtifactWorkspaceKey } from "../../memory/memory-artifact-provenance.js";
import {
  readForgottenMemoryArtifactSources,
  tombstoneMemoryArtifactSources,
} from "../../memory/memory-artifact-source-forget.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  assertInsideSkillsRoot,
  normalizeWorkspaceSkillSupportPath,
} from "../lifecycle/workspace-skill-write.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import {
  forgetPendingSkillExperienceSources,
  listPendingSkillExperienceSourceMetadata,
} from "./experience-review-default.js";
import { discardSkillProposalSourceBundle } from "./proposal-generation.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import {
  assertWorkshopSourcesCurrent,
  validWorkshopSourceOrigin,
  workshopSourceOrigin,
  mergeWorkshopSourceOrigins,
} from "./source-provenance.js";
import {
  parseSkillProposalRow,
  parseJson,
  readStoredProposal,
  updateProposal,
} from "./store-sqlite-record.js";
import {
  databaseOptions,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import { withSkillProposalTargetLock } from "./target-lock.js";
import type { SkillProposalRecord } from "./types.js";

export type WorkshopSourceMetadata = {
  proposalId?: string;
  agentId: string;
  sourceWorkspaceKey: string;
  sourceKeys: string[];
  sourceRefs: NonNullable<SkillProposalRecord["origin"]>["sourceRefs"];
  sourceDeleted: boolean;
  sourceDeletedKeys: string[];
  skillKey?: string;
  skillFile?: string;
  status?: SkillProposalRecord["status"];
};

/** Content-free owning metadata. No transcript, proposal or provider content is returned. */
export async function listWorkshopSourceMetadata(
  params: { workspaceDir?: string; workspaceKey?: string } & SkillWorkshopStoreOptions,
): Promise<WorkshopSourceMetadata[]> {
  const workspaceKey = params.workspaceDir
    ? memoryArtifactWorkspaceKey(params.workspaceDir)
    : params.workspaceKey;
  if (!workspaceKey || !/^[a-f0-9]{64}$/u.test(workspaceKey)) {
    throw new Error("Workshop source workspace unavailable");
  }
  const database = await openExistingOpenClawStateDatabaseReadOnly(databaseOptions(params));
  const pending: WorkshopSourceMetadata[] = params.workspaceDir
    ? listPendingSkillExperienceSourceMetadata(params.workspaceDir)
        .filter((row) => !params.agentId || row.agentId === params.agentId)
        .map((row) => {
          const origin = workshopSourceOrigin(params.workspaceDir!, row.sourceRefs);
          return {
            agentId: row.agentId,
            sourceWorkspaceKey: workspaceKey,
            sourceKeys: origin.sourceKeys!,
            sourceRefs: origin.sourceRefs!,
            sourceDeleted: false,
            sourceDeletedKeys: [],
          };
        })
    : [];
  if (!database) {
    return pending;
  }
  try {
    if (!tableExists(database.db, "skill_workshop_proposals")) {
      return pending;
    }
    const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database.db);
    let query = kysely.selectFrom("skill_workshop_proposals").selectAll();
    if (params.agentId) {
      query = query.where("owner_agent_id", "=", params.agentId);
    }
    const rows = executeSqliteQuerySync(database.db, query.limit(10001)).rows;
    if (rows.length > 10000) {
      throw new Error("Workshop source metadata needs_expansion");
    }
    return [
      ...pending,
      ...rows.flatMap((row) => {
        const record = parseSkillProposalRow(row);
        // SAFETY: This optional JSON marker probe grants no authority; returned metadata still
        // SAFETY: Metadata requires parseSkillProposalRow and validWorkshopSourceOrigin; JSON has no accessors.
        const raw = parseJson(row.record_json) as
          | { origin?: { sourceWorkspaceKey?: unknown } }
          | undefined;
        if (!record && raw?.origin?.sourceWorkspaceKey === workspaceKey) {
          throw new Error("Workshop source metadata unavailable");
        }
        if (
          !record ||
          !record.origin?.sourceKeys?.length ||
          record.origin.sourceWorkspaceKey !== workspaceKey
        ) {
          return [];
        }
        if (!row.owner_agent_id) {
          throw new Error("Workshop source owner unavailable");
        }
        if (!validWorkshopSourceOrigin(record.origin)) {
          throw new Error("Workshop source provenance unavailable");
        }
        return [
          {
            proposalId: record.id,
            agentId: row.owner_agent_id,
            sourceWorkspaceKey: workspaceKey,
            sourceKeys: [...record.origin.sourceKeys],
            sourceRefs: structuredClone(record.origin.sourceRefs),
            sourceDeleted: record.origin.sourceDeleted === true,
            sourceDeletedKeys: [...(record.origin.sourceDeletedKeys ?? [])],
            skillKey: record.target.skillKey,
            skillFile: record.target.skillFile,
            status: record.status,
          },
        ];
      }),
    ];
  } finally {
    database.walMaintenance.close();
  }
}

/** Exact-source deletion preserves applied identity/lifecycle/recovery state and unrelated proposals. */
export async function forgetWorkshopSourceExamples(
  params: {
    workspaceDir: string;
    sourceKeys: readonly string[];
    dryRun?: boolean;
  } & SkillWorkshopStoreOptions,
) {
  if (
    !params.sourceKeys.length ||
    params.sourceKeys.length > 64 ||
    params.sourceKeys.some((key) => !/^[a-f0-9]{64}$/u.test(key))
  ) {
    throw new Error("Workshop source selector invalid");
  }
  const selected = new Set(params.sourceKeys);
  const rows = await listWorkshopSourceMetadata(params);
  const known = new Set(rows.flatMap((row) => row.sourceKeys));
  const alreadyForgotten = await readForgottenMemoryArtifactSources({
    workspaceDir: params.workspaceDir,
    sourceKeys: params.sourceKeys,
  });
  if (params.sourceKeys.some((key) => !known.has(key) && !alreadyForgotten.has(key))) {
    throw new Error("Workshop source selector has no owning provenance");
  }
  const pendingSources = new Set<string>();
  const refusals: string[] = [];
  let scrubbedProposals = 0;
  if (!params.dryRun) {
    await tombstoneMemoryArtifactSources({
      workspaceDir: params.workspaceDir,
      sourceKeys: params.sourceKeys,
    });
    forgetPendingSkillExperienceSources(params.workspaceDir, params.sourceKeys);
  }
  for (const row of rows.filter(
    (candidate): candidate is WorkshopSourceMetadata & { proposalId: string } =>
      Boolean(candidate.proposalId) && candidate.sourceKeys.some((key) => selected.has(key)),
  )) {
    const options = { ...params, agentId: row.agentId };
    const initial = readStoredProposal(row.proposalId, options);
    if (!initial) {
      row.sourceKeys.filter((key) => selected.has(key)).forEach((key) => pendingSources.add(key));
      refusals.push(`${row.proposalId}:record_unavailable`);
      continue;
    }
    try {
      await withSkillProposalTargetLock(
        initial.record,
        async () => {
          const current = readStoredProposal(row.proposalId, options);
          if (
            !current ||
            current.record.origin?.sourceWorkspaceKey !== row.sourceWorkspaceKey ||
            !current.record.origin.sourceKeys?.some((key) => selected.has(key))
          ) {
            throw new Error("Workshop source record changed");
          }
          if (params.dryRun) {
            return;
          }
          const record: SkillProposalRecord = {
            ...current.record,
            title: "Source-deleted proposal",
            description: "Source deleted; reconciliation required",
            scan: { ...current.record.scan, critical: 0, warn: 0, info: 0, findings: [] },
            statusReason: "Source deleted",
            origin: {
              ...current.record.origin,
              sourceDeleted: true,
              sourceDeletedKeys: [
                ...new Set([
                  ...(current.record.origin.sourceDeletedKeys ?? []),
                  ...current.record.origin.sourceKeys.filter((key) => selected.has(key)),
                ]),
              ].toSorted(),
            },
          };
          delete record.evidence;
          delete record.goal;
          delete record.evaluation;
          delete record.supportFiles;
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              const latest = readStoredProposal(row.proposalId, options);
              if (!latest || latest.row.record_json !== current.row.record_json) {
                throw new Error("Workshop source record changed before scrub");
              }
              updateProposal(db, latest.row, record);
              const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
              executeSqliteQuerySync(
                db,
                kysely
                  .updateTable("skill_workshop_proposal_events")
                  .set({ payload_json: null })
                  .where("proposal_id", "=", record.id),
              );
            },
            databaseOptions(options),
            { operationLabel: "skill-workshop.source-forget" },
          );
          // Durable marker and cache invalidation precede physical purge. The target identity/lifecycle remain.
          bumpSkillsSnapshotVersion({ workspaceDir: params.workspaceDir, reason: "workshop" });
          if (record.status === "applied") {
            if (!record.sourceAppliedFiles?.length) {
              throw new Error("Workshop applied source receipt unavailable");
            }
            const skillsRoot = resolveWorkshopSkillsDir(
              params.config ?? {},
              row.agentId,
              params.env,
            );
            assertInsideSkillsRoot(skillsRoot, record.target.skillDir, "source-deleted skill");
            const skillRoot = await root(record.target.skillDir);
            for (const file of record.sourceAppliedFiles) {
              if (file.relativePath !== "SKILL.md") {
                normalizeWorkspaceSkillSupportPath(file.relativePath);
              }
              let content: Buffer;
              try {
                content = (
                  await skillRoot.read(file.relativePath, {
                    hardlinks: "reject",
                    symlinks: "reject",
                    maxBytes: 1024 * 1024,
                  })
                ).buffer;
              } catch (error) {
                if (error instanceof FsSafeError && error.code === "not-found") {
                  continue;
                }
                throw error;
              }
              if (hashSkillProposalContent(content.toString("utf8")) !== file.sha256) {
                throw new Error("Workshop applied source preimage changed");
              }
              // All normal Workshop writers hold this same target lease. No manual/unknown bytes are erased.
              await removePathWithinRoot({
                rootDir: record.target.skillDir,
                relativePath: file.relativePath,
                force: false,
              });
            }
          }
          await discardSkillProposalSourceBundle(record, options);
          scrubbedProposals++;
        },
        options,
      );
    } catch {
      row.sourceKeys.filter((key) => selected.has(key)).forEach((key) => pendingSources.add(key));
      refusals.push(`${row.proposalId}:source_cleanup_unavailable`);
    }
  }
  return {
    scope: "linked_source_provenance_only" as const,
    pendingSources: [...pendingSources].toSorted(),
    refusals,
    scrubbedProposals,
    appliedLifecyclePreserved: true,
    targetDirectoriesPreserved: true,
  };
}

/** Existing applied identity remains, while its source-deleted prompt capability is held. */
export async function listWorkshopUnavailableSkillKeys(params: {
  workspaceDir: string;
  agentId?: string;
}) {
  const rows = await listWorkshopSourceMetadata(params);
  return new Set(
    rows
      .filter((row) => row.sourceDeleted && row.status === "applied" && row.skillKey)
      .map((row) => row.skillKey!),
  );
}

/** A NEW update cannot detach unchanged current generated bytes from their original exact source. */
export async function readWorkshopAppliedTargetOrigin(
  params: {
    workspaceDir: string;
    skillFile: string;
    contentHash: string;
  } & SkillWorkshopStoreOptions,
) {
  const rows = (await listWorkshopSourceMetadata(params)).filter(
    (row) => row.status === "applied" && row.skillFile === params.skillFile && row.proposalId,
  );
  let origin: SkillProposalRecord["origin"];
  if (!rows.length) {
    return origin;
  }
  let matched = false;
  for (const row of rows) {
    const stored = readStoredProposal(row.proposalId!, params);
    if (!stored) {
      throw new Error("Workshop applied source provenance unavailable");
    }
    const applied = stored.record.sourceAppliedFiles?.find(
      (file) => file.relativePath === "SKILL.md",
    );
    if (!applied || applied.sha256 !== params.contentHash) {
      continue;
    }
    matched = true;
    origin = mergeWorkshopSourceOrigins(origin, stored.record.origin);
  }
  if (!matched) {
    throw new Error("Workshop applied source preimage unavailable");
  }
  await assertWorkshopSourcesCurrent(origin, params.workspaceDir, params);
  return origin;
}
