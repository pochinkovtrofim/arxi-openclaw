import fs from "node:fs/promises";
import path from "node:path";
import {
  projectMemoryArtifactSourceContent,
  readMemoryArtifactProvenance,
  recordMemoryArtifactWriteProvenance,
  checkMemoryArtifactSources,
  readForgottenMemoryArtifactSources,
  type MemoryArtifactSourceRef,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";

/** Current model input is separate from the exact raw preimage used by CAS. */
export async function readDreamingSource(
  workspaceDir: string,
  filePath: string,
  checkedRaw?: string,
) {
  let missing = false;
  const raw =
    checkedRaw ??
    (await fs.readFile(filePath, "utf8").catch((error: unknown) => {
      // SAFETY: Only the native fs.readFile rejection reaches this callback; code is optional.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing = true;
        return "";
      }
      throw error;
    }));
  const relativePath = path.relative(workspaceDir, filePath).replaceAll("\\", "/");
  const provenance = await readMemoryArtifactProvenance({ workspaceDir, relativePath });
  const current = await projectMemoryArtifactSourceContent({
    workspaceDir,
    relativePath,
    content: raw,
  });
  const verified = await readMemoryArtifactProvenance({ workspaceDir, relativePath });
  // Projection may persist a tombstone itself. Bind refs to that same exact
  // physical preimage, while refusing another writer's concurrent replacement.
  if (
    Boolean(provenance?.sourceLineage) !== Boolean(verified?.sourceLineage) ||
    (provenance?.sourceLineage &&
      (verified?.fileHash !== provenance.fileHash ||
        JSON.stringify(verified?.sourceLineage?.sources) !==
          JSON.stringify(provenance.sourceLineage.sources)))
  ) {
    throw new Error("Dreaming source changed during read; reread current evidence");
  }
  return {
    raw,
    missing,
    content: current.content,
    status: current.status,
    sourceBound: Boolean(provenance?.sourceLineage),
    refsForRange(from = 1, to = Number.MAX_SAFE_INTEGER): MemoryArtifactSourceRef[] {
      const lineage = provenance?.sourceLineage;
      if (!lineage) {
        return [];
      }
      const keys = new Set(
        lineage.regions
          .filter(
            (region) =>
              region.from <= to &&
              region.to >= from &&
              !current.blockedRegions.some(
                (blocked) => blocked.from <= region.to && blocked.to >= region.from,
              ),
          )
          .flatMap((region) => region.sources),
      );
      return [...keys].map((key) => lineage.sources[key]!);
    },
  };
}

function uniqueSourceRefs(refs: readonly MemoryArtifactSourceRef[]) {
  return [...new Map(refs.map((ref) => [JSON.stringify([ref.ownerId, ref.value]), ref])).values()];
}

export async function assertDreamingSourcesCurrent(
  workspaceDir: string,
  refs: readonly MemoryArtifactSourceRef[],
) {
  const statuses = await checkMemoryArtifactSources(uniqueSourceRefs(refs));
  if (
    [...statuses.values()].some((status) => status !== "current") ||
    (await readForgottenMemoryArtifactSources({ workspaceDir, sourceKeys: [...statuses.keys()] }))
      .size
  ) {
    throw new Error("Dreaming source changed or unavailable; reread current evidence");
  }
}

/** Reserve the existing lineage owner before publication, retaining uncertain writes. */
export async function commitDreamingSourceWrite(params: {
  workspaceDir: string;
  filePath: string;
  before: string;
  after: string;
  refs?: readonly MemoryArtifactSourceRef[];
  commit: () => Promise<void>;
}) {
  const relativePath = path.relative(params.workspaceDir, params.filePath).replaceAll("\\", "/");
  const refs = uniqueSourceRefs(params.refs ?? []);
  const recorded = await readMemoryArtifactProvenance({
    workspaceDir: params.workspaceDir,
    relativePath,
  });
  if (!recorded?.sourceLineage && refs.length === 0) {
    return params.commit();
  }
  await assertDreamingSourcesCurrent(params.workspaceDir, refs);
  const rollback = await recordMemoryArtifactWriteProvenance({
    workspaceDir: params.workspaceDir,
    relativePath,
    contentBefore: params.before,
    contentAfter: params.after,
    originClass: "agent",
    observedAt: Date.now(),
    sourceRefs: refs,
  });
  if (!rollback) {
    throw new Error("Dreaming source lineage path unavailable; publication held");
  }
  try {
    await assertDreamingSourcesCurrent(params.workspaceDir, refs);
    await params.commit();
  } catch (error) {
    // An error after dispatch can mean publication. Only exact unchanged bytes
    // permit rollback; an uncertain outcome keeps readers fenced by lineage.
    const actual = await fs.readFile(params.filePath, "utf8").catch((readError: unknown) => {
      // SAFETY: This rejection comes directly from native fs.readFile; only optional errno is read.
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      return undefined;
    });
    if (actual === params.before) {
      await rollback();
    }
    throw error;
  }
}

/** Copy only a known workspace's current source, retaining its real dependencies. */
export async function copyDreamingSource(params: {
  sourceWorkspaceDir: string;
  sourcePath: string;
  workspaceDir: string;
  destination: string;
}) {
  const relative = path.relative(params.sourceWorkspaceDir, params.sourcePath);
  const inSourceWorkspace =
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const source = inSourceWorkspace
    ? await readDreamingSource(params.sourceWorkspaceDir, params.sourcePath)
    : undefined;
  // An unattributed import cannot mint source authority from a path.
  const content = source?.content ?? (await fs.readFile(params.sourcePath, "utf8"));
  if (source?.sourceBound && source.status !== "current") {
    throw new Error("Historical dreaming source unavailable; import held");
  }
  const refs = source?.refsForRange() ?? [];
  const assertCurrent = async () => {
    if (!source?.sourceBound) {
      return;
    }
    const current = await readDreamingSource(params.sourceWorkspaceDir, params.sourcePath);
    if (
      current.status !== "current" ||
      current.raw !== source.raw ||
      JSON.stringify(uniqueSourceRefs(current.refsForRange())) !==
        JSON.stringify(uniqueSourceRefs(refs))
    ) {
      throw new Error("Historical dreaming source changed or unavailable; import held");
    }
    await assertDreamingSourcesCurrent(params.sourceWorkspaceDir, refs);
  };
  await assertCurrent();
  await commitDreamingSourceWrite({
    workspaceDir: params.workspaceDir,
    filePath: params.destination,
    before: "",
    after: content,
    refs,
    commit: () => fs.writeFile(params.destination, content),
  });
  return { refs, assertCurrent };
}
