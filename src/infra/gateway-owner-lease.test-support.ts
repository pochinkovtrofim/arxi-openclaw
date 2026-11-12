import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import {
  acquireGatewayOwnerLease,
  assertGatewayOwnerLeaseStopped,
  type GatewayOwnerLease,
} from "./gateway-owner-lease.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";

/** Temp state dirs and a Gateway owner fixture, cleaned after every test. */
export function useGatewayOwnerLeaseFixture() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  function fixture() {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-") };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const coordinator = acquireGatewayStateOwner({
      databasePath,
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
        role: "gateway",
      },
    });
    let lease: GatewayOwnerLease | undefined;
    return {
      env,
      assertStopped(admission?: Parameters<typeof assertGatewayOwnerLeaseStopped>[3]) {
        return coordinator.run(() =>
          assertGatewayOwnerLeaseStopped(env, coordinator, false, admission),
        );
      },
      acquire(params: Partial<Omit<Parameters<typeof acquireGatewayOwnerLease>[0], "env">> = {}) {
        lease = acquireGatewayOwnerLease({
          env,
          port: 19483,
          mode: "foreground",
          supervisor: null,
          ...params,
        });
        return lease;
      },
      async [Symbol.asyncDispose]() {
        try {
          await lease?.ready;
        } finally {
          await lease?.release();
          coordinator.release();
        }
      },
    };
  }

  return { tempDirs, fixture };
}

export function seedOwner(
  env: NodeJS.ProcessEnv,
  params: {
    pid?: number;
    host?: string;
    startedAt?: number | null;
    expiresAt?: number | null;
    heartbeatAt?: number;
    processNamespace?: unknown;
  } = {},
) {
  withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) => {
      db.prepare(
        `INSERT INTO state_leases
         (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
         VALUES ('gateway-owner', 'global', 'previous-generation', ?, ?, ?, ?, ?)`,
      ).run(
        params.expiresAt === undefined ? Date.now() + 300_000 : params.expiresAt,
        params.heartbeatAt ?? Date.now(),
        JSON.stringify({
          owner: {
            pid: params.pid ?? process.pid,
            host: params.host ?? hostname(),
            ...(params.processNamespace === undefined
              ? {}
              : { processNamespace: params.processNamespace }),
            startedAt:
              params.startedAt === undefined
                ? pidAlive.getFileLockProcessStartTime(process.pid)
                : params.startedAt,
          },
          port: 19483,
          mode: "foreground",
          supervisor: null,
        }),
        Date.now(),
        Date.now(),
      );
    },
    { env },
  );
}

export function mockLinuxNamespace(root: string) {
  if (process.platform !== "linux") {
    vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
      platform: "linux",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
    }));
    const stat = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation((file, options) =>
      stat(file === "/proc/self/ns/pid" ? root : file, options),
    );
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    readGatewayLockProcessNamespace();
    platform.mockRestore();
  }
  const namespace = readGatewayLockProcessNamespace();
  if (!namespace || !("pidNsInode" in namespace)) {
    throw new Error("Expected Linux process namespace identity");
  }
  return namespace;
}
