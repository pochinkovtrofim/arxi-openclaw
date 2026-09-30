import { memoryArtifactWorkspaceKey } from "../../memory/memory-artifact-provenance.js";
import {
  checkMemoryArtifactSources,
  memoryArtifactSourceKey,
  type MemoryArtifactSourceRef,
} from "../../memory/memory-artifact-source-authority.js";
import { readForgottenMemoryArtifactSourcesByWorkspaceKey } from "../../memory/memory-artifact-source-forget.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import type { SkillProposalOrigin } from "./types.js";

/** Correlation only: authority remains with each native source owner. */
export function workshopSourceOrigin(
  workspaceDir: string,
  refs: readonly MemoryArtifactSourceRef[],
): Pick<SkillProposalOrigin, "sourceWorkspaceKey" | "sourceKeys" | "sourceRefs"> {
  const sourceRefs = Object.fromEntries(
    refs.map((ref) => [memoryArtifactSourceKey(ref), { ...ref }]),
  );
  const sourceKeys = Object.keys(sourceRefs).toSorted();
  if (sourceKeys.length > 64) {
    throw new Error("Workshop source provenance needs_expansion");
  }
  return sourceKeys.length
    ? { sourceWorkspaceKey: memoryArtifactWorkspaceKey(workspaceDir), sourceKeys, sourceRefs }
    : {};
}

export function validWorkshopSourceOrigin(origin: SkillProposalOrigin): boolean {
  const present =
    origin.sourceKeys !== undefined ||
    origin.sourceRefs !== undefined ||
    origin.sourceWorkspaceKey !== undefined;
  if (!present) {
    return origin.sourceDeleted === undefined && origin.sourceDeletedKeys === undefined;
  }
  if (
    !/^[a-f0-9]{64}$/u.test(origin.sourceWorkspaceKey ?? "") ||
    !Array.isArray(origin.sourceKeys) ||
    !origin.sourceKeys.length ||
    origin.sourceKeys.length > 64 ||
    !origin.sourceRefs ||
    typeof origin.sourceRefs !== "object" ||
    Array.isArray(origin.sourceRefs) ||
    (origin.sourceDeleted !== undefined &&
      (typeof origin.sourceDeleted !== "boolean" || !origin.sourceDeleted)) ||
    (origin.sourceDeleted
      ? !Array.isArray(origin.sourceDeletedKeys) ||
        !origin.sourceDeletedKeys.length ||
        origin.sourceDeletedKeys.some((key) => !origin.sourceKeys!.includes(key))
      : origin.sourceDeletedKeys !== undefined)
  ) {
    return false;
  }
  try {
    const keys = Object.keys(origin.sourceRefs).toSorted();
    return (
      keys.length === origin.sourceKeys.length &&
      new Set(origin.sourceKeys).size === keys.length &&
      keys.every((key) => {
        const ref = origin.sourceRefs?.[key];
        if (!ref) {
          return false;
        }
        return origin.sourceKeys!.includes(key) && memoryArtifactSourceKey(ref) === key;
      })
    );
  } catch {
    return false;
  }
}

export function mergeWorkshopSourceOrigins(
  previous: SkillProposalOrigin | undefined,
  next: SkillProposalOrigin | undefined,
): SkillProposalOrigin | undefined {
  if (
    (previous && !validWorkshopSourceOrigin(previous)) ||
    (next && !validWorkshopSourceOrigin(next))
  ) {
    throw new Error("Workshop source provenance unavailable");
  }
  if (previous?.sourceDeleted || next?.sourceDeleted) {
    throw new Error("Workshop source was deleted");
  }
  if (
    previous?.sourceWorkspaceKey &&
    next?.sourceWorkspaceKey &&
    previous.sourceWorkspaceKey !== next.sourceWorkspaceKey
  ) {
    throw new Error("Workshop source workspace changed");
  }
  const sourceRefs = { ...previous?.sourceRefs, ...next?.sourceRefs };
  const sourceKeys = Object.keys(sourceRefs).toSorted();
  if (sourceKeys.length > 64) {
    throw new Error("Workshop source provenance needs_expansion");
  }
  const origin = next ?? previous;
  return origin
    ? {
        ...origin,
        ...(sourceKeys.length
          ? {
              sourceKeys,
              sourceRefs,
              sourceWorkspaceKey: previous?.sourceWorkspaceKey ?? next?.sourceWorkspaceKey,
            }
          : {}),
      }
    : undefined;
}

export async function assertWorkshopSourcesCurrent(
  origin: SkillProposalOrigin | undefined,
  workspaceDir?: string,
  store: SkillWorkshopStoreOptions = {},
) {
  if (!origin) {
    return;
  }
  if (!validWorkshopSourceOrigin(origin) || origin.sourceDeleted) {
    throw new Error("Workshop source was deleted or unavailable");
  }
  if (!origin.sourceKeys?.length) {
    return;
  }
  if (workspaceDir && origin.sourceWorkspaceKey !== memoryArtifactWorkspaceKey(workspaceDir)) {
    throw new Error("Workshop source workspace changed");
  }
  const { listWorkshopSourceMetadata } = await import("./store.js");
  const rows = await listWorkshopSourceMetadata({
    ...store,
    agentId: undefined,
    workspaceKey: origin.sourceWorkspaceKey!,
  });
  if (
    rows.some(
      (row) =>
        row.sourceDeleted && row.sourceDeletedKeys.some((key) => origin.sourceKeys!.includes(key)),
    ) ||
    (
      await readForgottenMemoryArtifactSourcesByWorkspaceKey({
        workspaceKey: origin.sourceWorkspaceKey!,
        sourceKeys: origin.sourceKeys,
      })
    ).size
  ) {
    throw new Error("Workshop source was deleted");
  }
  const statuses = await checkMemoryArtifactSources(Object.values(origin.sourceRefs!), {
    signal: AbortSignal.timeout(2000),
  });
  if ([...statuses.values()].some((status) => status !== "current")) {
    throw new Error("Workshop source currentness unavailable");
  }
}
