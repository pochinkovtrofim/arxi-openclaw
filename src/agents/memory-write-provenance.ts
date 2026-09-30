import path from "node:path";
import { isMissingPathError } from "../infra/errors.js";
import { canonicalPathFromExistingAncestor } from "../infra/fs-safe.js";
import { logWarn } from "../logger.js";
import {
  clearMemoryArtifactProvenance,
  normalizeMemoryArtifactRelativePath,
  recordMemoryArtifactWriteProvenance,
  projectMemoryArtifactSourceContent,
  readForgottenMemoryArtifactSources,
} from "../memory/memory-artifact-provenance.js";
import {
  readMemoryArtifactSourceScope,
  checkMemoryArtifactSources,
  memoryArtifactSourceKey,
} from "../memory/memory-artifact-source-authority.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";

export type MemoryWriteProvenanceObserver = {
  classifies: (absolutePath: string) => Promise<boolean>;
  write: (params: {
    absolutePath: string;
    contentBefore: string;
    contentAfter: string;
    commit: () => Promise<void>;
  }) => Promise<void>;
  read?: (absolutePath: string, content: string) => Promise<string>;
  clearAfterDelete: (absolutePath: string, contentBefore: string) => Promise<void>;
};

type ProvenanceWriteOperations = {
  readFile: (absolutePath: string) => Promise<Buffer | string>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  remove?: (absolutePath: string) => Promise<void>;
};

export function withMemoryWriteProvenance<T extends ProvenanceWriteOperations>(
  operations: T,
  observer: MemoryWriteProvenanceObserver | undefined,
): T {
  if (!observer) {
    return operations;
  }
  const remove = operations.remove;
  return {
    ...operations,
    writeFile: async (absolutePath: string, content: string) => {
      // Retained provenance callbacks keep the invocation's original owner.
      const assertCurrent = captureAgentToolSourceExecutionGuard();
      const commit = () => {
        assertCurrent();
        return operations.writeFile(absolutePath, content);
      };
      if (!(await observer.classifies(absolutePath))) {
        await commit();
        return;
      }
      const contentBefore = await operations
        .readFile(absolutePath)
        .then((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value))
        .catch((error: unknown) => {
          if (!isMissingPathError(error)) {
            throw error;
          }
          return "";
        });
      await observer.write({
        absolutePath,
        contentBefore,
        contentAfter: content,
        commit,
      });
    },
    ...(remove
      ? {
          remove: async (absolutePath: string) => {
            const assertCurrent = captureAgentToolSourceExecutionGuard();
            const contentBefore = (await observer.classifies(absolutePath))
              ? await operations
                  .readFile(absolutePath)
                  .then((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value))
                  .catch((error: unknown) => {
                    if (!isMissingPathError(error)) {
                      throw error;
                    }
                    return "";
                  })
              : "";
            assertCurrent();
            await remove(absolutePath);
            await observer.clearAfterDelete(absolutePath, contentBefore);
          },
        }
      : {}),
  } as T;
}

function resolveMemoryRelativePath(root: string, absolutePath: string): string | undefined {
  const relativePath = path.relative(root, absolutePath);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  return normalizeMemoryArtifactRelativePath(relativePath.replaceAll(path.sep, "/"));
}

export function createMemoryWriteProvenanceObserver(params: {
  mutationRoot: string;
  workspaceDir: string;
  resolvePath?: (filePath: string) => Promise<string>;
  resolveOriginClass: () => "agent" | "untrusted";
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  abortSignal?: AbortSignal;
  now?: () => number;
}): MemoryWriteProvenanceObserver {
  const now = params.now ?? Date.now;
  const resolvePath = params.resolvePath ?? canonicalPathFromExistingAncestor;
  const resolveRelativePath = async (absolutePath: string) => {
    // Both paths must be canonicalized by the same filesystem owner: container
    // paths are not host paths, and aliases must retain memory quarantine.
    const [root, target] = await Promise.all([
      resolvePath(params.mutationRoot),
      resolvePath(absolutePath),
    ]);
    return resolveMemoryRelativePath(root, target);
  };
  return {
    classifies: async (absolutePath) => (await resolveRelativePath(absolutePath)) !== undefined,
    read: async (absolutePath, content) => {
      const relativePath = await resolveRelativePath(absolutePath);
      if (!relativePath) {
        return content;
      }
      return (
        await projectMemoryArtifactSourceContent({
          workspaceDir: params.workspaceDir,
          relativePath,
          content,
          signal: params.abortSignal,
        })
      ).content;
    },
    write: async ({ absolutePath, contentBefore, contentAfter, commit }) => {
      const relativePath = await resolveRelativePath(absolutePath);
      if (!relativePath) {
        await commit();
        return;
      }
      const refs = readMemoryArtifactSourceScope(params.runId, params.workspaceDir) ?? [];
      const sourceStatuses = await checkMemoryArtifactSources(refs, { signal: params.abortSignal });
      if ([...sourceStatuses.values()].some((status) => status !== "current")) {
        throw new Error("Memory write source changed or unavailable; reread current source");
      }
      const rollback = await recordMemoryArtifactWriteProvenance({
        workspaceDir: params.workspaceDir,
        relativePath,
        contentBefore,
        contentAfter,
        originClass: params.resolveOriginClass(),
        observedAt: now(),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sourceRefs: refs,
      });
      try {
        readMemoryArtifactSourceScope(params.runId, params.workspaceDir);
        const current = await checkMemoryArtifactSources(refs, { signal: params.abortSignal });
        if ([...current.values()].some((status) => status !== "current")) {
          throw new Error("Memory write source changed before commit");
        }
        if (
          (
            await readForgottenMemoryArtifactSources({
              workspaceDir: params.workspaceDir,
              sourceKeys: refs.map(memoryArtifactSourceKey),
            })
          ).size
        ) {
          throw new Error("Memory source was forgotten before write");
        }
        readMemoryArtifactSourceScope(params.runId, params.workspaceDir);
        await commit();
      } catch (error) {
        try {
          await rollback?.();
        } catch (rollbackError) {
          throw new Error(
            `File write failed and memory provenance rollback also failed: ${String(error)}`,
            { cause: rollbackError },
          );
        }
        throw error;
      }
    },
    clearAfterDelete: async (absolutePath, contentBefore) => {
      const relativePath = await resolveRelativePath(absolutePath);
      if (!relativePath) {
        return;
      }
      try {
        await clearMemoryArtifactProvenance({
          workspaceDir: params.workspaceDir,
          relativePath,
          contentBefore,
        });
      } catch (error) {
        // The file is already gone. Retaining stale quarantine is safer than
        // reporting the filesystem mutation as failed after it committed.
        logWarn(`memory provenance cleanup failed for ${relativePath}: ${String(error)}`);
      }
    },
  };
}
