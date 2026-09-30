import { createHash } from "node:crypto";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  getActiveAgentRunDelegatedAuthority,
  getAgentRunContext,
} from "../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Opaque code-owned source identity. It contains IDs/hashes, never source text. */
export type MemoryArtifactSourceRef = { ownerId: string; value: string };
export type MemoryArtifactSourceStatus = "current" | "revoked" | "unavailable";
export const MEMORY_ARTIFACT_SOURCE_LIMIT = 64;
const MAX_RUN_SCOPES = 256;
const authorities = resolveGlobalSingleton(
  Symbol.for("openclaw.memoryArtifactSourceAuthorities"),
  () => ({
    resolvers: new Map<
      string,
      (
        refs: readonly string[],
        options: { signal?: AbortSignal },
      ) => Promise<readonly MemoryArtifactSourceStatus[]>
    >(),
    runs: new Map<
      string,
      {
        workspaceDir: string;
        instanceId: string;
        assertCurrent: () => void;
        refs: MemoryArtifactSourceRef[];
        complete: boolean;
      }
    >(),
  }),
);

export function memoryArtifactSourceKey(ref: MemoryArtifactSourceRef): string {
  if (
    !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(ref.ownerId) ||
    Buffer.byteLength(ref.value) > 2048 ||
    !ref.value
  ) {
    throw new Error("Invalid memory source attestation");
  }
  return createHash("sha256").update(ref.ownerId).update("\0").update(ref.value).digest("hex");
}

/** Trusted owning plugin registration; a missing/reloaded owner never makes old evidence current. */
export function registerMemoryArtifactSourceResolver(
  ownerId: string,
  check: (
    refs: readonly string[],
    options: { signal?: AbortSignal },
  ) => Promise<readonly MemoryArtifactSourceStatus[]>,
) {
  memoryArtifactSourceKey({ ownerId, value: "registration" });
  if (authorities.resolvers.has(ownerId)) {
    throw new Error("Memory source owner already registered");
  }
  authorities.resolvers.set(ownerId, check);
  return () => {
    if (authorities.resolvers.get(ownerId) === check) {
      authorities.resolvers.delete(ownerId);
    }
  };
}

/** Called only by the native authorized prompt registrar, never by packet/model text. */
export function registerMemoryArtifactSourceScope(params: {
  runId: string;
  workspaceDir: string;
  assertCurrent: () => void;
  refs: readonly MemoryArtifactSourceRef[];
  complete: boolean;
}) {
  params.assertCurrent();
  const instanceId = getAgentRunContext(params.runId)?.delegatedAuthority?.operationalRunInstance
    .instanceId;
  if (!instanceId || !getActiveAgentRunDelegatedAuthority({ runId: params.runId, instanceId })) {
    throw new Error("Memory source native admission unavailable");
  }
  for (const [key, row] of authorities.runs) {
    try {
      row.assertCurrent();
      if (!getActiveAgentRunDelegatedAuthority({ runId: key, instanceId: row.instanceId })) {
        authorities.runs.delete(key);
      }
    } catch {
      authorities.runs.delete(key);
    }
  }
  const refs = [
    ...new Map(
      params.refs.map((ref) => [memoryArtifactSourceKey(ref), Object.freeze({ ...ref })]),
    ).values(),
  ];
  if (
    !params.runId ||
    !params.workspaceDir ||
    refs.length > MEMORY_ARTIFACT_SOURCE_LIMIT ||
    (!authorities.runs.has(params.runId) && authorities.runs.size >= MAX_RUN_SCOPES)
  ) {
    throw new Error("Memory source scope needs_expansion");
  }
  const old = authorities.runs.get(params.runId);
  if (old) {
    old.assertCurrent();
    if (old.instanceId !== instanceId || old.workspaceDir !== params.workspaceDir) {
      throw new Error("Memory source scope workspace changed");
    }
    const merged = [
      ...new Map([...old.refs, ...refs].map((ref) => [memoryArtifactSourceKey(ref), ref])).values(),
    ];
    if (merged.length > MEMORY_ARTIFACT_SOURCE_LIMIT) {
      old.complete = false;
      throw new Error("Memory source scope needs_expansion");
    }
    old.refs = merged;
    old.complete = old.complete && params.complete;
    return;
  }
  authorities.runs.set(params.runId, {
    workspaceDir: params.workspaceDir,
    instanceId,
    assertCurrent: params.assertCurrent,
    refs,
    complete: params.complete,
  });
}

export function readMemoryArtifactSourceScope(runId: string | undefined, workspaceDir: string) {
  if (!runId) {
    return undefined;
  }
  const scope = authorities.runs.get(runId);
  if (!scope) {
    return undefined;
  }
  scope.assertCurrent();
  if (!getActiveAgentRunDelegatedAuthority({ runId, instanceId: scope.instanceId })) {
    throw new Error("Memory source run already closed");
  }
  const caller = getGatewayToolCallerIdentity();
  if (
    !caller?.operationalRunInstance ||
    caller.operationalRunInstance.runId !== runId ||
    caller.operationalRunInstance.instanceId !== scope.instanceId ||
    caller.receiptAuthority?.() === false ||
    scope.workspaceDir !== workspaceDir ||
    !scope.complete
  ) {
    throw new Error("Memory source scope unavailable for this invocation");
  }
  return scope.refs;
}

/** Later source tools append only inside the actual admitted tool caller lifetime. */
export function recordMemoryArtifactSourcesFromActiveTool(
  refs: readonly MemoryArtifactSourceRef[],
) {
  const caller = getGatewayToolCallerIdentity();
  const runId = caller?.operationalRunInstance?.runId;
  const scope = runId ? authorities.runs.get(runId) : undefined;
  if (!caller || !scope) {
    return false;
  }
  if (
    caller.operationalRunInstance?.instanceId !== scope.instanceId ||
    caller.receiptAuthority?.() === false
  ) {
    throw new Error("Native memory source run authority unavailable");
  }
  scope.assertCurrent();
  if (!getActiveAgentRunDelegatedAuthority({ runId: runId!, instanceId: scope.instanceId })) {
    throw new Error("Memory source run already closed");
  }
  const next = [
    ...new Map(
      [...scope.refs, ...refs].map((ref) => [
        memoryArtifactSourceKey(ref),
        Object.freeze({ ...ref }),
      ]),
    ).values(),
  ];
  if (next.length > MEMORY_ARTIFACT_SOURCE_LIMIT) {
    scope.complete = false;
    throw new Error("Memory source scope needs_expansion");
  }
  scope.refs = next;
  return true;
}

export async function checkMemoryArtifactSources(
  refs: readonly MemoryArtifactSourceRef[],
  options: { signal?: AbortSignal } = {},
) {
  if (refs.length > MEMORY_ARTIFACT_SOURCE_LIMIT) {
    throw new Error("Memory source scope needs_expansion");
  }
  const statuses = new Map<string, MemoryArtifactSourceStatus>();
  const groups = new Map<string, MemoryArtifactSourceRef[]>();
  for (const ref of refs) {
    memoryArtifactSourceKey(ref);
    const rows = groups.get(ref.ownerId) ?? [];
    rows.push(ref);
    groups.set(ref.ownerId, rows);
  }
  await Promise.all(
    [...groups].map(async ([owner, rows]) => {
      const resolver = authorities.resolvers.get(owner);
      let results: readonly MemoryArtifactSourceStatus[] = [];
      let stop: (() => void) | undefined;
      try {
        const signal = options.signal;
        if (resolver && !signal?.aborted) {
          const unknown = new Promise<readonly MemoryArtifactSourceStatus[]>((resolve) => {
            stop = () => resolve([]);
            signal?.addEventListener("abort", stop, { once: true });
            if (signal?.aborted) {
              stop();
            }
          });
          results = await Promise.race([
            resolver(
              rows.map((r) => r.value),
              options,
            ),
            unknown,
          ]);
          if (signal?.aborted || authorities.resolvers.get(owner) !== resolver) {
            results = [];
          }
        }
      } catch {
        /* Unknown authority holds material. */
      } finally {
        if (stop) {
          options.signal?.removeEventListener("abort", stop);
        }
      }
      rows.forEach((ref, index) => {
        const status = results[index];
        statuses.set(
          memoryArtifactSourceKey(ref),
          results.length === rows.length &&
            (status === "current" || status === "revoked" || status === "unavailable")
            ? status
            : "unavailable",
        );
      });
    }),
  );
  return statuses;
}

/** Terminal run cleanup never transfers a captured source scope to a later turn. */
export function clearMemoryArtifactSourceScope(runId: string) {
  authorities.runs.delete(runId);
}

/** A late terminal callback cannot clear a different, still admitted instance. */
export function clearInactiveMemoryArtifactSourceScope(runId: string) {
  const scope = authorities.runs.get(runId);
  if (!scope) {
    return;
  }
  try {
    scope.assertCurrent();
    if (getActiveAgentRunDelegatedAuthority({ runId, instanceId: scope.instanceId })) {
      return;
    }
  } catch {
    /* The captured native/host authority has closed. */
  }
  if (authorities.runs.get(runId) === scope) {
    authorities.runs.delete(runId);
  }
}

/** Native harness snapshot before terminal cleanup; never callable through model arguments. */
export function captureMemoryArtifactSourceScope(runId: string | undefined, workspaceDir: string) {
  if (!runId) {
    return undefined;
  }
  const scope = authorities.runs.get(runId);
  if (!scope) {
    return undefined;
  }
  scope.assertCurrent();
  if (
    scope.workspaceDir !== workspaceDir ||
    !scope.complete ||
    !getActiveAgentRunDelegatedAuthority({ runId, instanceId: scope.instanceId })
  ) {
    throw new Error("Memory source native capture unavailable");
  }
  return scope.refs.map((ref) => Object.assign({}, ref));
}
