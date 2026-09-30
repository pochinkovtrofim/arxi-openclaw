import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { isMissingPathError } from "../infra/errors.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  checkMemoryArtifactSources,
  memoryArtifactSourceKey,
  recordMemoryArtifactSourcesFromActiveTool,
  type MemoryArtifactSourceRef,
} from "./memory-artifact-source-authority.js";
import { readForgottenMemoryArtifactSources } from "./memory-artifact-source-forget.js";
import {
  deriveMemoryArtifactSourceRegions,
  memorySourceLines,
  memorySourceTextHash,
  validateMemoryArtifactSourceLineage,
  type MemoryArtifactSourceLineage,
} from "./memory-artifact-source-regions.js";
export {
  readForgottenMemoryArtifactSources,
  tombstoneMemoryArtifactSources,
} from "./memory-artifact-source-forget.js";

const MEMORY_ARTIFACT_PROVENANCE_OWNER_ID = "core:memory-artifact-provenance";
const MEMORY_ARTIFACT_PROVENANCE_NAMESPACE = "workspace-files";
const MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES = 50_000;

export type MemoryArtifactOriginClass = "agent" | "untrusted";

export type MemoryArtifactProvenance = {
  fileHash: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
  sourceLineage?: MemoryArtifactSourceLineage;
};

type StoredMemoryArtifactProvenance = MemoryArtifactProvenance & {
  version: 1;
  workspaceKey: string;
  relativePath: string;
  reservationId: string;
};

type MemoryArtifactAddress = {
  workspaceKey: string;
  relativePath: string;
  storeKey: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  let canonical = resolved;
  try {
    // Provenance follows the physical workspace so symlink or junction aliases
    // cannot split the writer and reader into different trust records.
    canonical = realpathSync.native(resolved);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  const normalized = canonical.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function memoryArtifactWorkspaceKey(workspaceDir: string) {
  return sha256(normalizeWorkspaceKey(workspaceDir));
}

export function normalizeMemoryArtifactRelativePath(relativePath: string): string | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  if (["MEMORY.md", "memory.md", "USER.md", "DREAMS.md", "dreams.md"].includes(normalized)) {
    return normalized;
  }
  if (!normalized.startsWith("memory/") || !normalized.endsWith(".md")) {
    return undefined;
  }
  // Existing report artifacts use the same source guard. This classification
  // does not add them to search/index/promotion sources.
  return normalized;
}

function resolveAddress(params: {
  workspaceDir: string;
  relativePath: string;
}): MemoryArtifactAddress | undefined {
  const relativePath = normalizeMemoryArtifactRelativePath(params.relativePath);
  if (!relativePath) {
    return undefined;
  }
  const workspaceKey = sha256(normalizeWorkspaceKey(params.workspaceDir));
  return {
    workspaceKey,
    relativePath,
    storeKey: `${workspaceKey}:${sha256(relativePath)}`,
  };
}

function openStore() {
  return createCorePluginStateKeyedStore<StoredMemoryArtifactProvenance>({
    ownerId: MEMORY_ARTIFACT_PROVENANCE_OWNER_ID,
    namespace: MEMORY_ARTIFACT_PROVENANCE_NAMESPACE,
    maxEntries: MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function normalizeStoredProvenance(
  value: StoredMemoryArtifactProvenance | undefined,
  address: MemoryArtifactAddress,
): StoredMemoryArtifactProvenance | undefined {
  if (
    value?.version !== 1 ||
    value.workspaceKey !== address.workspaceKey ||
    value.relativePath !== address.relativePath ||
    !/^[a-f0-9]{64}$/u.test(value.fileHash) ||
    (value.originClass !== "agent" && value.originClass !== "untrusted") ||
    !Number.isSafeInteger(value.observedAt) ||
    typeof value.reservationId !== "string" ||
    value.reservationId.length === 0
  ) {
    return undefined;
  }
  if (value.sourceLineage) {
    validateMemoryArtifactSourceLineage(value.sourceLineage);
  }
  return value;
}

function toPublicProvenance(stored: StoredMemoryArtifactProvenance): MemoryArtifactProvenance {
  return {
    fileHash: stored.fileHash,
    originClass: stored.originClass,
    observedAt: stored.observedAt,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    ...(stored.sessionKey ? { sessionKey: stored.sessionKey } : {}),
    ...(stored.sourceLineage ? { sourceLineage: stored.sourceLineage } : {}),
  };
}

export async function recordMemoryArtifactWriteProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
  contentAfter: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
  sourceRefs?: readonly MemoryArtifactSourceRef[];
}): Promise<(() => Promise<void>) | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const store = openStore();
  const reservationId = randomUUID();
  let previous: StoredMemoryArtifactProvenance | undefined;
  const captured = normalizeStoredProvenance(await store.lookup(address.storeKey), address);
  if (captured?.sourceLineage && captured.fileHash !== sha256(params.contentBefore)) {
    throw new Error("Memory source content changed outside the owning writer; hold and reconcile");
  }
  const forgotten = await readForgottenMemoryArtifactSources({
    workspaceDir: params.workspaceDir,
    sourceKeys: (params.sourceRefs ?? []).map((ref) => memoryArtifactSourceKey(ref)),
  });
  if (forgotten.size) {
    throw new Error("Memory source was forgotten; old derived evidence cannot be rewritten");
  }
  const sourceLineage = deriveMemoryArtifactSourceRegions({
    before: params.contentBefore,
    after: params.contentAfter,
    previous: captured?.sourceLineage,
    refs: params.sourceRefs ?? [],
  });
  await store.update(address.storeKey, (current) => {
    previous = normalizeStoredProvenance(current, address);
    if (
      previous?.reservationId !== captured?.reservationId ||
      JSON.stringify(previous?.sourceLineage) !== JSON.stringify(captured?.sourceLineage)
    ) {
      throw new Error("Memory source provenance changed before write; hold and reread");
    }
    const originClass =
      params.originClass === "agent" &&
      (!previous ||
        (previous.originClass === "agent" && previous.fileHash === sha256(params.contentBefore)))
        ? "agent"
        : "untrusted";
    return {
      version: 1,
      workspaceKey: address.workspaceKey,
      relativePath: address.relativePath,
      fileHash: sha256(params.contentAfter),
      originClass,
      observedAt: params.observedAt,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      reservationId,
      ...(sourceLineage ? { sourceLineage } : {}),
    };
  });

  return async () => {
    const rollbackStore = openStore();
    if (previous) {
      await rollbackStore.update(address.storeKey, (current) =>
        current?.reservationId === reservationId ? previous : undefined,
      );
      return;
    }
    await rollbackStore.deleteIf(
      address.storeKey,
      (current) => current.reservationId === reservationId,
    );
  };
}

export async function clearMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
}): Promise<void> {
  const address = resolveAddress(params);
  if (!address) {
    return;
  }
  const expectedHash = sha256(params.contentBefore);
  await openStore().deleteIf(address.storeKey, (current) => current.fileHash === expectedHash);
}

export async function readMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<MemoryArtifactProvenance | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const stored = normalizeStoredProvenance(await openStore().lookup(address.storeKey), address);
  return stored ? toPublicProvenance(stored) : undefined;
}

export async function listMemoryArtifactProvenance(params: {
  workspaceDir: string;
}): Promise<Array<{ relativePath: string; provenance: MemoryArtifactProvenance }>> {
  const workspaceKey = sha256(normalizeWorkspaceKey(params.workspaceDir));
  const prefix = `${workspaceKey}:`;
  return (await openStore().entries())
    .filter((entry) => entry.key.startsWith(prefix))
    .flatMap((entry) => {
      const address = {
        workspaceKey,
        relativePath: entry.value.relativePath,
        storeKey: entry.key,
      };
      const stored = normalizeStoredProvenance(entry.value, address);
      return stored
        ? [{ relativePath: stored.relativePath, provenance: toPublicProvenance(stored) }]
        : [];
    });
}

/** Persistent per-region depublication. Disk bytes remain history, never live source evidence. */
export async function projectMemoryArtifactSourceContent(params: {
  workspaceDir: string;
  relativePath: string;
  content: string;
  signal?: AbortSignal;
}): Promise<{
  content: string;
  status: "current" | "tombstoned" | "held";
  blockedRegions: Array<{ from: number; to: number }>;
  tombstonedRegions: Array<{ from: number; to: number }>;
  lineageFileHash?: string;
}> {
  const address = resolveAddress(params);
  const unchanged = {
    content: params.content,
    status: "current" as const,
    blockedRegions: [],
    tombstonedRegions: [],
  };
  if (!address) {
    return unchanged;
  }
  const store = openStore();
  const observed = normalizeStoredProvenance(await store.lookup(address.storeKey), address);
  const lineage = observed?.sourceLineage;
  if (!observed || !lineage) {
    return unchanged;
  }
  if (observed.fileHash !== sha256(params.content)) {
    return {
      content: "",
      status: "held",
      blockedRegions: [{ from: 1, to: Math.max(1, memorySourceLines(params.content).length) }],
      tombstonedRegions: [],
      lineageFileHash: observed.fileHash,
    };
  }
  const statuses = await checkMemoryArtifactSources(Object.values(lineage.sources), {
    signal: params.signal,
  });
  const forgotten = await readForgottenMemoryArtifactSources({
    workspaceDir: params.workspaceDir,
    sourceKeys: Object.keys(lineage.sources),
  });
  for (const key of forgotten) {
    statuses.set(key, "revoked");
  }
  const lines = memorySourceLines(params.content);
  const revoked = new Set<number>();
  let held = false;
  const blockedRegions: Array<{ from: number; to: number }> = [];
  lineage.regions.forEach((region, index) => {
    if (
      region.to > lines.length ||
      memorySourceTextHash(lines.slice(region.from - 1, region.to).join("")) !== region.sha256
    ) {
      throw new Error("Memory source region identity changed; hold and reconcile");
    }
    const tombstoned =
      region.tombstoned || region.sources.some((id) => statuses.get(id) === "revoked");
    const unknown = region.sources.some((id) => statuses.get(id) !== "current");
    if (tombstoned) {
      revoked.add(index);
    }
    if (!tombstoned && unknown) {
      held = true;
    }
    if (tombstoned || unknown) {
      blockedRegions.push({ from: region.from, to: region.to });
    }
  });
  if (revoked.size) {
    await store.update(address.storeKey, (current) => {
      const row = normalizeStoredProvenance(current, address);
      // The writer/revision owning this exact byte preimage must still be current.
      // A concurrent native write is never tombstoned from an earlier source read.
      if (
        !row ||
        row.reservationId !== observed.reservationId ||
        row.fileHash !== observed.fileHash
      ) {
        throw new Error("Memory source write changed during reconciliation; hold and reread");
      }
      return {
        ...row,
        sourceLineage: {
          ...lineage,
          regions: row.sourceLineage!.regions.map((region, index) =>
            revoked.has(index) ? Object.assign({}, region, { tombstoned: true as const }) : region,
          ),
        },
      };
    });
  }
  const inherited = new Set<string>();
  lineage.regions.forEach((region) => {
    if (!blockedRegions.some((blocked) => blocked.from <= region.to && blocked.to >= region.from)) {
      region.sources.forEach((id) => inherited.add(id));
    }
  });
  recordMemoryArtifactSourcesFromActiveTool(
    [...inherited].map((id) => {
      const ref = lineage.sources[id];
      if (!ref) {
        throw new Error("Memory source reference missing; hold and reconcile");
      }
      return ref;
    }),
  );
  for (const region of blockedRegions) {
    for (let i = region.from - 1; i < region.to; i++) {
      const line = lines[i];
      if (line === undefined) {
        throw new Error("Memory source region exceeds its preimage");
      }
      lines[i] = line.endsWith("\n") ? "\n" : "";
    }
  }
  return {
    content: lines.join(""),
    status: held ? "held" : blockedRegions.length ? "tombstoned" : "current",
    blockedRegions,
    lineageFileHash: observed.fileHash,
    tombstonedRegions: lineage.regions
      .filter((_, index) => revoked.has(index))
      .map(({ from, to }) => ({ from, to })),
  };
}
