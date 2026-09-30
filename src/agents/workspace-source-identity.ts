import { sameFileIdentity, type FileIdentityStat } from "../infra/fs-safe-advanced.js";

export type WorkspaceFileSourceIdentity = readonly [
  canonicalPath: string,
  stat: FileIdentityStat,
  exactIdentity: string,
];
// Loader-owned records retain the pinned-open identity through final session filtering.
const workspaceFileSourceIdentities = new WeakMap<object, WorkspaceFileSourceIdentity>();

export function setWorkspaceFileSourceIdentity(
  file: object,
  sourceIdentity: WorkspaceFileSourceIdentity,
): void {
  workspaceFileSourceIdentities.set(file, sourceIdentity);
}

function getWorkspaceFileSourceIdentity(file: object): WorkspaceFileSourceIdentity | undefined {
  return workspaceFileSourceIdentities.get(file);
}

export function workspaceFileSourceIdentitiesMatch(left: object, right: object): boolean {
  const leftIdentity = getWorkspaceFileSourceIdentity(left);
  const rightIdentity = getWorkspaceFileSourceIdentity(right);
  return leftIdentity?.[2] === rightIdentity?.[2];
}

export function workspaceFilesShareSourceIdentity(left: object, right: object): boolean {
  const leftIdentity = getWorkspaceFileSourceIdentity(left);
  const rightIdentity = getWorkspaceFileSourceIdentity(right);
  if (!leftIdentity || !rightIdentity) {
    return false;
  }
  return (
    leftIdentity[0] === rightIdentity[0] || sameFileIdentity(leftIdentity[1], rightIdentity[1])
  );
}
