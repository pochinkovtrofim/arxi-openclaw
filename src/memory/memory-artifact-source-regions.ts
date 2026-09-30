import { createHash } from "node:crypto";
import { diffLines } from "diff";
import {
  memoryArtifactSourceKey,
  type MemoryArtifactSourceRef,
} from "./memory-artifact-source-authority.js";

export type MemoryArtifactSourceRegion = {
  from: number;
  to: number;
  sha256: string;
  sources: string[];
  tombstoned?: true;
};
export type MemoryArtifactSourceLineage = {
  sources: Record<string, MemoryArtifactSourceRef>;
  regions: MemoryArtifactSourceRegion[];
};
export const memorySourceTextHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const memorySourceLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
const MAX_REGIONS = 256;

/** Keep exact unchanged ranges; new tool-written ranges inherit only admitted source dependencies. */
export function deriveMemoryArtifactSourceRegions(params: {
  before: string;
  after: string;
  previous?: MemoryArtifactSourceLineage;
  refs: readonly MemoryArtifactSourceRef[];
}): MemoryArtifactSourceLineage | undefined {
  if (!params.previous && !params.refs.length) {
    return undefined;
  }
  if (Buffer.byteLength(params.before) + Buffer.byteLength(params.after) > 524288) {
    throw new Error("Memory source region diff needs_expansion");
  }
  const sources = { ...params.previous?.sources };
  const ids = params.refs.map((ref) => {
    const key = memoryArtifactSourceKey(ref);
    sources[key] = ref;
    return key;
  });
  const regions: MemoryArtifactSourceRegion[] = [];
  let oldLine = 1;
  let newLine = 1;
  let removedSources: string[] = [];
  let removedTombstone = false;
  for (const part of diffLines(params.before, params.after)) {
    const lines = memorySourceLines(part.value);
    const count = lines.length;
    if (part.removed) {
      const removed = (params.previous?.regions ?? []).filter(
        (region) => region.from <= oldLine + count - 1 && region.to >= oldLine,
      );
      removedSources = [...new Set(removed.flatMap((region) => region.sources))];
      removedTombstone = removed.some((region) => region.tombstoned);
      oldLine += count;
      continue;
    }
    if (part.added) {
      const dependencies = [...new Set([...ids, ...removedSources])];
      if (dependencies.length && part.value.trim()) {
        regions.push({
          from: newLine,
          to: newLine + count - 1,
          sha256: memorySourceTextHash(part.value),
          sources: dependencies,
          ...(removedTombstone ? { tombstoned: true as const } : {}),
        });
      }
      removedSources = [];
      removedTombstone = false;
    } else {
      removedSources = [];
      removedTombstone = false;
      for (const region of params.previous?.regions ?? []) {
        const from = Math.max(region.from, oldLine);
        const to = Math.min(region.to, oldLine + count - 1);
        if (from > to) {
          continue;
        }
        regions.push({
          ...region,
          from: newLine + from - oldLine,
          to: newLine + to - oldLine,
          sha256: memorySourceTextHash(lines.slice(from - oldLine, to - oldLine + 1).join("")),
        });
      }
      oldLine += count;
    }
    newLine += count;
  }
  if (regions.length > MAX_REGIONS || Object.keys(sources).length > 64) {
    throw new Error("Memory source regions need_expansion");
  }
  const retained = new Set(regions.flatMap((region) => region.sources));
  return regions.length
    ? {
        sources: Object.fromEntries(Object.entries(sources).filter(([key]) => retained.has(key))),
        regions,
      }
    : undefined;
}

export function validateMemoryArtifactSourceLineage(lineage: MemoryArtifactSourceLineage) {
  if (
    !lineage ||
    !Array.isArray(lineage.regions) ||
    lineage.regions.length > MAX_REGIONS ||
    Object.keys(lineage.sources).length > 64
  ) {
    throw new Error("Memory source lineage unavailable");
  }
  for (const [key, ref] of Object.entries(lineage.sources)) {
    if (memoryArtifactSourceKey(ref) !== key) {
      throw new Error("Memory source lineage unavailable");
    }
  }
  let previousEnd = 0;
  for (const region of [...lineage.regions].toSorted((a, b) => a.from - b.from)) {
    if (
      !Number.isSafeInteger(region.from) ||
      !Number.isSafeInteger(region.to) ||
      region.from <= previousEnd ||
      region.to < region.from ||
      !/^[a-f0-9]{64}$/u.test(region.sha256) ||
      !region.sources.length ||
      region.sources.some((id) => !Object.hasOwn(lineage.sources, id)) ||
      (region.tombstoned !== undefined &&
        (typeof region.tombstoned !== "boolean" || !region.tombstoned))
    ) {
      throw new Error("Memory source lineage unavailable");
    }
    previousEnd = region.to;
  }
}
