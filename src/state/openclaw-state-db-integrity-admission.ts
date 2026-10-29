import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { registerSqliteSchemaMutationListener } from "../infra/sqlite-schema-facts.js";
import type { DatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateIntegrityAdmission } from "./openclaw-state-db-async-lifecycle.js";
import { readTrackedStateDatabaseIdentity } from "./openclaw-state-db-handle.js";

const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.stateIntegrityBindings"),
  () => new WeakMap<DatabaseSync, { revision: SharedArrayBuffer; release(): void }>(),
);

const STARTUP_PROOF_MAX_AGE_MS = 30_000;
// Not reset with the restarting generation: the next generation's first open consumes it.
const startupProofs = resolveGlobalSingleton(
  Symbol.for("openclaw.stateStartupIntegrityProofs"),
  () => new Map<string, { birthtime?: string; metadata: bigint; checkedAtMs: number }>(),
);

export type OpenClawStateIntegrityPolicy = "verify" | "require-proof";
type OpenClawStateSchemaMetadata = { schemaVersion: number; userVersion: number };

function schemaMetadata(schema: OpenClawStateSchemaMetadata): bigint {
  return BigInt.asIntN(
    64,
    (BigInt(schema.userVersion >>> 0) << 32n) | BigInt(schema.schemaVersion >>> 0),
  );
}

/**
 * The Gateway lock's full check of this file and schema also covers the runtime's
 * first open of it moments later, so a wake reads the state database once.
 */
export function recordOpenClawStateStartupIntegrityProof(
  identity: DatabaseFileIdentity,
  schema: OpenClawStateSchemaMetadata,
): void {
  startupProofs.set(identity.key, {
    birthtime: identity.birthtime,
    metadata: schemaMetadata(schema),
    checkedAtMs: Date.now(),
  });
}

function takeStartupProof(identity: DatabaseFileIdentity, metadata: bigint): boolean {
  const proof = startupProofs.get(identity.key);
  startupProofs.delete(identity.key);
  if (proof === undefined) {
    return false;
  }
  // A wall clock stepped back (clone-init sets it) must not keep a proof alive.
  const ageMs = Date.now() - proof.checkedAtMs;
  return (
    proof.birthtime === identity.birthtime &&
    proof.metadata === metadata &&
    ageMs >= 0 &&
    ageMs <= STARTUP_PROOF_MAX_AGE_MS
  );
}

function assertSqliteIntegrityUnlessStartupProof(
  database: DatabaseSync,
  pathname: string,
  schema: OpenClawStateSchemaMetadata,
): void {
  const identity = readTrackedStateDatabaseIdentity(database);
  if (!identity?.key.startsWith("file:") || !takeStartupProof(identity, schemaMetadata(schema))) {
    assertSqliteIntegrity(database, pathname);
  }
}

function invalidate(revision: BigInt64Array): void {
  let previous = Atomics.load(revision, 0);
  while (previous >= 0n) {
    const observed = Atomics.compareExchange(revision, 0, previous, previous + 1n);
    if (observed === previous) {
      return;
    }
    previous = observed;
  }
}

/** Corruption observed in an isolate revokes the exact host proof borrowed by its native handle. */
export function invalidateOpenClawStateRuntimeIntegrity(database: DatabaseSync): void {
  const bound = bindings.get(database);
  if (bound) {
    invalidate(new BigInt64Array(bound.revision));
  }
}

/** Native bindings revoke borrowed proof; the host generation alone owns its lifetime. */
function bind(database: DatabaseSync, admission: OpenClawStateIntegrityAdmission): void {
  if (bindings.get(database)?.revision === admission.revision) {
    return;
  }
  bindings.get(database)?.release();
  const revision = new BigInt64Array(admission.revision);
  const unobserve = registerSqliteSchemaMutationListener(database, () => invalidate(revision));
  const release = () => {
    unobserve();
    unregister();
    // Failed rollback can close before its corruption reaches the owner; retain the receipt until GC.
  };
  const unregister = registerNodeSqliteDisposeCallback(database, (reason) => {
    if (reason === "replace") {
      invalidate(revision);
    }
    release();
  });
  bindings.set(database, { revision: admission.revision, release });
}

/** Reuse only completed integrity proof; shape and mutable metadata retain their admission owners. */
export function assertOpenClawStateRuntimeIntegrity(
  database: DatabaseSync,
  pathname: string,
  schema: OpenClawStateSchemaMetadata,
  admission?: OpenClawStateIntegrityAdmission,
  policy: OpenClawStateIntegrityPolicy = "verify",
): (() => void) | undefined {
  const identity = admission && readTrackedStateDatabaseIdentity(database);
  if (
    !admission ||
    !identity ||
    !identity.key.startsWith("file:") ||
    identity.key !== admission.identity.key ||
    identity.birthtime !== admission.identity.birthtime
  ) {
    if (policy === "require-proof") {
      throw new Error("Shared-state reader requires current worker integrity proof");
    }
    assertSqliteIntegrityUnlessStartupProof(database, pathname, schema);
    return undefined;
  }
  bind(database, admission);
  const revision = new BigInt64Array(admission.revision);
  const proof = new BigInt64Array(admission.proof);
  const metadata = schemaMetadata(schema);
  const observed = Atomics.load(proof, 0);
  if (Atomics.load(revision, 0) === admission.epoch && observed !== -1n) {
    if (observed === metadata && Atomics.load(revision, 0) === admission.epoch) {
      return undefined;
    }
    invalidate(revision);
  }
  if (policy === "require-proof") {
    throw new Error("Shared-state reader requires current worker integrity proof");
  }
  assertSqliteIntegrityUnlessStartupProof(database, pathname, schema);
  const publish = () => {
    if (Atomics.load(revision, 0) === admission.epoch) {
      Atomics.store(proof, 0, metadata);
    }
  };
  return () => {
    if (database.isTransaction) {
      stageSqliteTransactionState(database, { stage() {}, rollback() {}, commit: publish });
    } else {
      publish();
    }
  };
}
