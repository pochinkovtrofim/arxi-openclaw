import { mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import {
  captureOpenClawAgentDatabaseValidationTransfer,
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidationForTransfer,
} from "./openclaw-agent-db-validation-cache.js";
import {
  cleanupRetiredAgentDatabaseLease,
  readAgentDatabaseClosedReceipt,
} from "./openclaw-agent-execution-cleanup.js";
import {
  assertOpenClawStateSchemaRepairAllowed,
  getExistingOpenClawStateSchemaPath,
} from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerCleanupOperations } from "./openclaw-state-worker-contract.js";

const edge = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  openFailure: undefined as Error | undefined,
  repairs: [] as Array<{ phase: string; error: unknown }>,
  forbidden: vi.fn((): never => {
    throw new Error("Cleanup schema proof crossed a native database or Worker boundary");
  }),
}));

vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: edge.forbidden,
}));
vi.mock("../infra/sqlite-worker-identity.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/sqlite-worker-identity.js")>(
    "../infra/sqlite-worker-identity.js",
  )),
  readDatabasePathIdentity: async (canonicalPath: string) => ({
    key: "file:synthetic-state",
    canonicalPath,
  }),
}));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-worker-store.js")>()),
  openOpenClawStateWorkerCleanupStore: async (
    databasePath: string,
    context: SqliteWorkerStateContext,
  ) => {
    runWithSqliteWorkerStateContext(context, () => inspectRepairPolicy("open", databasePath));
    if (edge.openFailure) {
      throw edge.openFailure;
    }
    const store: SqliteWorkerStore<
      Pick<OpenClawStateWorkerCleanupOperations, "agentDatabases.releaseExitedLease">
    > = {
      async execute(command) {
        inspectRepairPolicy("cleanup", command.input.sharedStatePath);
      },
      close: edge.close,
    };
    return store;
  },
}));
vi.mock("../infra/sqlite-worker-store.js", () => ({
  runSqliteWorkerStoreOperation: async (
    store: SqliteWorkerStore<
      Pick<OpenClawStateWorkerCleanupOperations, "agentDatabases.releaseExitedLease">
    >,
    operation: (
      scope: SqliteWorkerStore<
        Pick<OpenClawStateWorkerCleanupOperations, "agentDatabases.releaseExitedLease">
      >,
    ) => Promise<void>,
    context: SqliteWorkerStateContext,
  ) => runWithSqliteWorkerStateContext(context, () => operation(store)),
}));

function inspectRepairPolicy(phase: string, databasePath: string) {
  let error: unknown;
  try {
    assertOpenClawStateSchemaRepairAllowed(databasePath);
  } catch (failure) {
    error = failure;
  }
  edge.repairs.push({ phase, error });
}

afterEach(() => {
  expect(edge.forbidden).not.toHaveBeenCalled();
  edge.openFailure = undefined;
  clearOpenClawAgentDatabaseValidationCache("/synthetic/reader-recovery");
  edge.repairs.length = 0;
  vi.clearAllMocks();
});

it("retains installed-schema repair ownership through retired agent lease cleanup", async () => {
  const databasePath = "/synthetic/state/openclaw.sqlite";
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    existingSchemaPath: databasePath,
    admission: {
      coordinationKey: "file:synthetic-state",
      databasePath,
      identity: { key: "file:synthetic-state", canonicalPath: databasePath },
      assertCurrent() {},
    },
  };
  // There is no ambient schema scope for the mocked transport to inherit.
  expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
  await cleanupRetiredAgentDatabaseLease({
    context,
    stopped: Promise.resolve(),
    assertOwned() {},
    lease: {
      leaseId: "synthetic-lease",
      agentId: "main",
      path: "/synthetic/agents/main.sqlite",
      ownerPid: process.pid,
      ownerStartTime: null,
      sharedStatePath: databasePath,
      sharedStateIdentity: "file:synthetic-state",
    },
  });
  expect(edge.repairs).toEqual(
    ["open", "cleanup"].map((phase) => ({
      phase,
      error: expect.objectContaining({
        message: expect.stringContaining("schema repair is owned by the existing installation"),
      }),
    })),
  );
  expect(edge.close).toHaveBeenCalledOnce();
  expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
});

it("revokes retired reader validation when shared cleanup admission fails", async () => {
  const databasePath = "/synthetic/state/openclaw.sqlite";
  const target = { agentId: "main", path: "/synthetic/reader-recovery/main.sqlite" };
  const valid = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const canonicalReady = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(valid), 0, 1);
  Atomics.store(new Int32Array(canonicalReady), 0, 1);
  const receipt = {
    agentId: target.agentId,
    identity: "synthetic-agent",
    receiptId: "reader-recovery-proof",
    valid,
    canonicalReady,
  };
  expect(captureOpenClawAgentDatabaseValidationTransfer(target)(receipt.identity, receipt)).toBe(
    true,
  );
  expect(getOpenClawAgentDatabaseValidationForTransfer(target)).toMatchObject({
    receiptId: receipt.receiptId,
  });

  const failure = new Error("shared state is undergoing offline maintenance");
  edge.openFailure = failure;
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    existingSchemaPath: databasePath,
    admission: {
      coordinationKey: "file:synthetic-state",
      databasePath,
      identity: { key: "file:synthetic-state", canonicalPath: databasePath },
      assertCurrent() {},
    },
  };
  await expect(
    cleanupRetiredAgentDatabaseLease({
      context,
      stopped: Promise.resolve(),
      assertOwned() {},
      lease: {
        leaseId: "synthetic-retired-lease",
        ...target,
        ownerPid: process.pid,
        ownerStartTime: null,
        sharedStatePath: databasePath,
        sharedStateIdentity: "file:synthetic-state",
      },
    }),
  ).rejects.toBe(failure);

  expect(getOpenClawAgentDatabaseValidationForTransfer(target)).toBeUndefined();
  expect(Atomics.load(new Int32Array(valid), 0)).toBe(0);
  expect(edge.close).not.toHaveBeenCalled();
});

it("completes a confirmed native retirement after another file replaces the shared database", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "openclaw-retired-lease-")));
  try {
    const databasePath = path.join(root, "openclaw.sqlite");
    await writeFile(databasePath, "");
    const leased = await stat(databasePath, { bigint: true });
    // A remount over the state directory leaves a different file at the leased path.
    const replacement = path.join(root, "replacement.sqlite");
    await writeFile(replacement, "");
    await rename(replacement, databasePath);
    const context: OpenClawStateWorkerContext = {
      environment: { OPENCLAW_STATE_DIR: root },
      admission: {
        coordinationKey: `file:${leased.dev}:${leased.ino}`,
        databasePath,
        identity: { key: `file:${leased.dev}:${leased.ino}`, canonicalPath: databasePath },
        assertCurrent() {},
      },
    };
    const lease = {
      leaseId: "synthetic-closed-lease",
      agentId: "main",
      path: path.join(root, "agents/main.sqlite"),
      ownerPid: process.pid,
      ownerStartTime: null,
      sharedStatePath: databasePath,
      sharedStateIdentity: `file:${leased.dev}:${leased.ino}`,
    };

    const incarnation = "synthetic-incarnation";
    const closed = readAgentDatabaseClosedReceipt(
      {
        identity: { key: "file:1:2", canonicalPath: lease.path },
        incarnation,
        checkpoint: {
          health: {
            state: "complete",
            observedAtMs: 0,
            walBytes: 0,
            databaseBytes: 0,
            logFrames: 0,
            checkpointedFrames: 0,
            lastCompletedAtMs: 0,
            consecutiveBlocked: 0,
            warning: false,
          },
          observedAtNs: 0n,
        },
      },
      { kind: "file", physicalIdentity: "1:2", incarnation, nativeLocation: lease.path },
      lease,
    );
    expect(closed).toBeDefined();

    await expect(
      cleanupRetiredAgentDatabaseLease({
        context,
        stopped: Promise.resolve(),
        assertOwned() {},
        lease,
        closed: () => closed,
      }),
    ).resolves.toBeUndefined();
    expect(edge.repairs).toEqual([]);
    expect(edge.close).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
