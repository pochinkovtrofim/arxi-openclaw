import { createHash } from "node:crypto";
import { readMemoryFile } from "../../packages/memory-host-sdk/src/host/read-file.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  listMemoryArtifactProvenance,
  memoryArtifactWorkspaceKey,
} from "./memory-artifact-provenance.js";
import { memorySourceLines, memorySourceTextHash } from "./memory-artifact-source-regions.js";

export type MemoryArtifactSourceForgetPlan = {
  version: 1;
  sourceKeys: string[];
  files: Array<{
    relativePath: string;
    fileHash: string;
    afterHash?: string;
    regions: Array<{ from: number; to: number; sha256: string }>;
  }>;
  pending: string[];
};

function planStore() {
  return createCorePluginStateKeyedStore<MemoryArtifactSourceForgetPlan>({
    ownerId: "core:memory-artifact-provenance",
    namespace: "source-forget-plans",
    maxEntries: 50_000,
    overflowPolicy: "reject-new",
  });
}

function planKey(params: { workspaceDir: string; sourceKeys: readonly string[] }) {
  if (
    !params.sourceKeys.length ||
    params.sourceKeys.length > 64 ||
    params.sourceKeys.some((key) => !/^[a-f0-9]{64}$/u.test(key))
  ) {
    throw new Error("Memory source forget selector invalid");
  }
  return `${memoryArtifactWorkspaceKey(params.workspaceDir)}:${createHash("sha256")
    .update([...new Set(params.sourceKeys)].toSorted().join("\n"))
    .digest("hex")}`;
}

async function captureFile(
  params: { workspaceDir: string; sourceKeys: readonly string[] },
  entry: Awaited<ReturnType<typeof listMemoryArtifactProvenance>>[number],
) {
  const selected = new Set(params.sourceKeys);
  const regions =
    entry.provenance.sourceLineage?.regions
      .filter((region) => region.sources.some((source) => selected.has(source)))
      .map(({ from, to, sha256 }) => ({ from, to, sha256 })) ?? [];
  if (!regions.length) {
    return undefined;
  }
  let afterHash: string | undefined;
  try {
    let content: string | undefined;
    await readMemoryFile({
      workspaceDir: params.workspaceDir,
      relPath: entry.relativePath,
      from: 1,
      lines: 1,
      projectContent: async (row) => {
        content = row.content;
        return row.content;
      },
    });
    if (content === undefined) {
      throw new Error("Memory source preimage unavailable");
    }
    const lines = memorySourceLines(content);
    if (
      memorySourceTextHash(content) === entry.provenance.fileHash &&
      regions.every(
        (region) =>
          region.to <= lines.length &&
          memorySourceTextHash(lines.slice(region.from - 1, region.to).join("")) === region.sha256,
      )
    ) {
      for (const region of regions) {
        for (let i = region.from - 1; i < region.to; i++) {
          const line = lines[i];
          if (line === undefined) {
            throw new Error("Memory source region exceeds its preimage");
          }
          lines[i] = line.endsWith("\n") ? "\n" : "";
        }
      }
      afterHash = memorySourceTextHash(lines.join(""));
    }
  } catch {
    /* Missing or manually changed files stay pending, never broaden deletion. */
  }
  return {
    relativePath: entry.relativePath,
    fileHash: entry.provenance.fileHash,
    ...(afterHash ? { afterHash } : {}),
    regions,
  };
}

/** The native provenance owner captures the original hashes before any purge. */
export async function prepareMemoryArtifactSourceForgetPlan(params: {
  workspaceDir: string;
  sourceKeys: readonly string[];
  dryRun?: boolean;
}): Promise<MemoryArtifactSourceForgetPlan> {
  const key = planKey(params);
  const existing = await planStore().lookup(key);
  if (existing) {
    // A manual conflict can be restored to the original native preimage later.
    // Recheck that exact proof without replacing any recorded original hash.
    for (const file of existing.files) {
      if (file.afterHash) {
        continue;
      }
      try {
        let content: string | undefined;
        await readMemoryFile({
          workspaceDir: params.workspaceDir,
          relPath: file.relativePath,
          from: 1,
          lines: 1,
          projectContent: async (row) => {
            content = row.content;
            return row.content;
          },
        });
        if (content === undefined || memorySourceTextHash(content) !== file.fileHash) {
          continue;
        }
        const lines = memorySourceLines(content);
        if (
          file.regions.some(
            (region) =>
              region.to > lines.length ||
              memorySourceTextHash(lines.slice(region.from - 1, region.to).join("")) !==
                region.sha256,
          )
        ) {
          continue;
        }
        for (const region of file.regions) {
          for (let i = region.from - 1; i < region.to; i++) {
            const line = lines[i];
            if (line === undefined) {
              throw new Error("Memory source region exceeds its preimage");
            }
            lines[i] = line.endsWith("\n") ? "\n" : "";
          }
        }
        file.afterHash = memorySourceTextHash(lines.join(""));
      } catch {
        /* Retain original content-free evidence for another retry. */
      }
    }
    if (!params.dryRun) {
      await planStore().update(key, (current) =>
        current ? { ...current, files: existing.files } : undefined,
      );
    }
    return existing;
  }
  const selected = new Set(params.sourceKeys);
  const provenance = await listMemoryArtifactProvenance({ workspaceDir: params.workspaceDir });
  const files: MemoryArtifactSourceForgetPlan["files"] = [];
  for (const entry of provenance) {
    const file = await captureFile(params, entry);
    if (file) {
      files.push(file);
    }
  }
  if (files.length > 128) {
    throw new Error("Memory source forget plan needs_expansion");
  }
  const known = new Set(
    provenance.flatMap((entry) => Object.keys(entry.provenance.sourceLineage?.sources ?? {})),
  );
  const forgotten = await readForgottenMemoryArtifactSources(params);
  if (params.sourceKeys.some((source) => !known.has(source) && !forgotten.has(source))) {
    throw new Error("Memory source forget selector has no native lineage");
  }
  const plan: MemoryArtifactSourceForgetPlan = {
    version: 1,
    sourceKeys: [...selected].toSorted(),
    files,
    pending: [],
  };
  if (!params.dryRun) {
    await planStore().registerIfAbsent(key, plan);
  }
  return params.dryRun ? plan : ((await planStore().lookup(key)) ?? plan);
}

/** Catch native writers crossing plan capture without changing an old preimage. */
export async function reconcileMemoryArtifactSourceForgetPlan(params: {
  workspaceDir: string;
  sourceKeys: readonly string[];
}) {
  const key = planKey(params);
  const stored = await planStore().lookup(key);
  if (!stored) {
    throw new Error("Memory source forget plan unavailable");
  }
  const files = new Map(stored.files.map((file) => [file.relativePath, file]));
  const added: MemoryArtifactSourceForgetPlan["files"] = [];
  const pending: string[] = [];
  for (const entry of await listMemoryArtifactProvenance({ workspaceDir: params.workspaceDir })) {
    const candidate = await captureFile(params, entry);
    if (!candidate) {
      continue;
    }
    const old = files.get(candidate.relativePath);
    if (old) {
      const covered =
        (candidate.fileHash === old.fileHash || candidate.fileHash === old.afterHash) &&
        candidate.regions.every((region) =>
          old.regions.some(
            (original) =>
              original.from === region.from &&
              original.to === region.to &&
              original.sha256 === region.sha256,
          ),
        );
      if (!covered) {
        pending.push(`file:${candidate.relativePath}:unplanned_native_preimage`);
      }
      continue;
    }
    if (files.size + added.length >= 128) {
      pending.push(`file:${candidate.relativePath}:needs_expansion`);
      continue;
    }
    added.push(candidate);
  }
  if (added.length) {
    await planStore().update(key, (current) => {
      if (!current) {
        throw new Error("Memory source forget plan unavailable");
      }
      // Never replace an original hash, even if another admitted forget won.
      return {
        ...current,
        files: [
          ...current.files,
          ...added.filter(
            (file) => !current.files.some((old) => old.relativePath === file.relativePath),
          ),
        ],
      };
    });
  }
  const plan = await planStore().lookup(key);
  if (!plan) {
    throw new Error("Memory source forget plan unavailable");
  }
  return { plan, addedPaths: added.map((file) => file.relativePath), pending };
}

/** Updates cleanup evidence only; original selector and preimages are immutable. */
export async function recordMemoryArtifactSourceForgetPending(params: {
  workspaceDir: string;
  sourceKeys: readonly string[];
  pending: readonly string[];
}): Promise<void> {
  if (params.pending.length > 512 || params.pending.some((value) => value.length > 2048)) {
    throw new Error("Memory source forget pending evidence needs_expansion");
  }
  const key = planKey(params);
  await planStore().update(key, (current) => {
    if (!current) {
      throw new Error("Memory source forget plan unavailable");
    }
    return { ...current, pending: [...new Set(params.pending)].toSorted() };
  });
}

function openSourceTombstoneStore() {
  return createCorePluginStateKeyedStore<{ sourceKey: string; observedAt: number }>({
    ownerId: "core:memory-artifact-provenance",
    namespace: "source-tombstones",
    maxEntries: 50_000,
    overflowPolicy: "reject-new",
  });
}

export async function readForgottenMemoryArtifactSources(params: {
  workspaceDir: string;
  sourceKeys: readonly string[];
}) {
  if (
    params.sourceKeys.length > 64 ||
    params.sourceKeys.some((key) => !/^[a-f0-9]{64}$/u.test(key))
  ) {
    throw new Error("Memory source forget selector invalid");
  }
  const workspaceKey = memoryArtifactWorkspaceKey(params.workspaceDir);
  const store = openSourceTombstoneStore();
  const rows = await Promise.all(
    params.sourceKeys.map((key) => store.lookup(`${workspaceKey}:${key}`)),
  );
  return new Set(params.sourceKeys.filter((key, index) => rows[index]?.sourceKey === key));
}

/** Native forget admission persists content-free identities before physical cleanup. */
export async function tombstoneMemoryArtifactSources(params: {
  workspaceDir: string;
  sourceKeys: readonly string[];
}) {
  const forgotten = await readForgottenMemoryArtifactSources(params);
  const entries = await listMemoryArtifactProvenance({ workspaceDir: params.workspaceDir });
  const known = new Set(
    entries.flatMap((entry) => Object.keys(entry.provenance.sourceLineage?.sources ?? {})),
  );
  // Workshop owning metadata attests captured identities only; this mints no memory artifact lineage.
  const { listWorkshopSourceMetadata } = await import("../skills/workshop/store.js");
  for (const row of await listWorkshopSourceMetadata({ workspaceDir: params.workspaceDir })) {
    for (const key of row.sourceKeys) {
      known.add(key);
    }
  }
  const captured = await planStore().lookup(planKey(params));
  for (const sourceKey of captured?.sourceKeys ?? []) {
    known.add(sourceKey);
  }
  if (params.sourceKeys.some((key) => !known.has(key) && !forgotten.has(key))) {
    throw new Error("Memory source forget selector has no native lineage");
  }
  const workspaceKey = memoryArtifactWorkspaceKey(params.workspaceDir);
  const store = openSourceTombstoneStore();
  for (const sourceKey of new Set(params.sourceKeys)) {
    await store.update(
      `${workspaceKey}:${sourceKey}`,
      (current) => current ?? { sourceKey, observedAt: Date.now() },
    );
  }
}

/** Content-free owning consumers already hold the original native workspace key. */
export async function readForgottenMemoryArtifactSourcesByWorkspaceKey(params: {
  workspaceKey: string;
  sourceKeys: readonly string[];
}) {
  if (
    !/^[a-f0-9]{64}$/u.test(params.workspaceKey) ||
    params.sourceKeys.length > 64 ||
    params.sourceKeys.some((key) => !/^[a-f0-9]{64}$/u.test(key))
  ) {
    throw new Error("Memory source forget selector invalid");
  }
  const store = openSourceTombstoneStore();
  const rows = await Promise.all(
    params.sourceKeys.map((key) => store.lookup(`${params.workspaceKey}:${key}`)),
  );
  return new Set(params.sourceKeys.filter((key, index) => rows[index]?.sourceKey === key));
}
