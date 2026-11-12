import fs from "node:fs";
import os, { hostname } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as pidAlive from "../shared/pid-alive.js";
import { closeOpenClawStateDatabaseAsync, withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { acquireGatewayOwnerLease, readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as snapshotSource from "./sqlite-snapshot-source.js";
import { mockLinuxNamespace, seedOwner, useGatewayOwnerLeaseFixture } from "./gateway-owner-lease.test-support.js";

const { tempDirs, fixture } = useGatewayOwnerLeaseFixture();

describe("Gateway owner lease", () => {
  it("reclaims a lease replayed from a VM snapshot of this exact process", async () => {
    await using owner = fixture();
    const { env } = owner;
    // A clone restores this PID, start time and boot identity under another clone's token.
    seedOwner(env, { processNamespace: readGatewayLockProcessNamespace() });
    expect(readGatewayOwnerLease({ env })).toMatchObject({
      owner: "previous-generation",
      pid: process.pid,
      state: "live",
      expired: false,
    });
    await expect(owner.assertStopped()).rejects.toThrow(
      "Another Gateway owner lease is still active",
    );
    await expect(owner.assertStopped({ reclaimReplayedSelf: true })).resolves.toBeUndefined();
    const lease = owner.acquire();
    await lease.ready;
    expect(readGatewayOwnerLease({ env })).toMatchObject({
      owner: lease.owner,
      pid: process.pid,
      state: "live",
    });
  });

  it.each([
    { label: "replayed with this exact process", startedAt: undefined, kept: ["parent"] },
    { label: "of a recycled PID", startedAt: 1, kept: ["parent", "self"] },
  ])("releases agent database leases only when the owner lease was $label", async (previous) => {
    await using owner = fixture();
    const { env } = owner;
    seedOwner(env, {
      processNamespace: readGatewayLockProcessNamespace(),
      startedAt: previous.startedAt,
    });
    const agentPath = path.join(
      env.OPENCLAW_STATE_DIR,
      "agents",
      "main",
      "agent",
      "openclaw.sqlite",
    );
    const leaseIds = () =>
      withOpenClawStateStartupMigrationCheckpointDatabase(
        (db) =>
          db
            .prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id")
            .all()
            .map((row) => row.lease_id),
        { env },
      );
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) => {
        const insert = db.prepare(
          "INSERT INTO agent_database_leases (lease_id, agent_id, path, owner_pid, owner_start_time, opened_at) VALUES (?, 'main', ?, ?, ?, ?)",
        );
        for (const [leaseId, pid] of [
          ["self", process.pid],
          ["parent", process.ppid],
        ] as const) {
          insert.run(
            leaseId,
            agentPath,
            pid,
            pidAlive.getFileLockProcessStartTime(pid),
            Date.now(),
          );
        }
      },
      { env },
    );
    const lease = owner.acquire();
    await lease.ready;
    expect(leaseIds()).toEqual(previous.kept);
  });

  it("lets only a starting Gateway reclaim a replayed lease through the lifecycle lock", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-replayed-") };
    const coordinator = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(env),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
        role: "gateway",
      },
    });
    try {
      seedOwner(env, { processNamespace: readGatewayLockProcessNamespace() });
    } finally {
      coordinator.release();
    }
    await closeOpenClawStateDatabaseAsync();
    await expect(
      acquireGatewayLock({ env, allowInTests: true, role: "sqlite-maintenance" }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Another Gateway owner lease is still active"),
      }),
    });
    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      port: 19483,
      listenerMode: "foreground",
    });
    if (!lock) {
      throw new Error("Expected gateway lock");
    }
    try {
      const current = readGatewayOwnerLease({ env });
      expect(current).toMatchObject({ pid: process.pid, state: "live" });
      expect(current?.owner).not.toBe("previous-generation");
    } finally {
      await lock.release();
    }
  });

  it.each([
    { label: "previous boot on the clone host", host: "owner-clone", reclaimed: true },
    { label: "fresh owner on another host", host: "another-host", reclaimed: false },
  ])(
    "after a snapshot clone renames the host, judges the $label without waiting",
    async ({ host, reclaimed }) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-clone-host-") };
      // A restored Gateway cached its namespace under the bake host before the rename.
      const restored = mockLinuxNamespace(env.OPENCLAW_STATE_DIR);
      const coordinator = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(env),
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
          role: "gateway",
        },
      });
      try {
        // The owner's preceding Gateway renewed its lease moments ago in another boot.
        seedOwner(env, {
          pid: 2_147_483_647,
          startedAt: 1,
          host,
          processNamespace: {
            ...restored,
            host,
            identity: "fedcba98-7654-3210-fedc-ba9876543210",
          },
        });
      } finally {
        coordinator.release();
      }
      await closeOpenClawStateDatabaseAsync();
      vi.spyOn(os, "hostname").mockReturnValue("owner-clone");
      const onWait = vi.fn();
      const acquiring = acquireGatewayLock({
        env,
        allowInTests: true,
        port: 19483,
        listenerMode: "foreground",
        timeoutMs: 0,
        onWait,
      });
      if (!reclaimed) {
        await expect(acquiring).rejects.toMatchObject({
          cause: expect.objectContaining({
            message: expect.stringContaining("owner heartbeat is fresh"),
          }),
        });
        expect(readGatewayOwnerLease({ env })?.owner).toBe("previous-generation");
        return;
      }
      const lock = await acquiring;
      if (!lock) {
        throw new Error("Expected gateway lock");
      }
      try {
        expect(onWait).not.toHaveBeenCalled();
        const current = readGatewayOwnerLease({ env });
        expect(current).toMatchObject({ pid: process.pid, state: "live" });
        expect(current?.owner).not.toBe("previous-generation");
        expect(current?.processNamespace).toMatchObject({ host: "owner-clone" });
      } finally {
        await lock.release();
      }
    },
  );

  it("keeps the live refusal for a Gateway generation this process published", async () => {
    await using owner = fixture();
    const { env } = owner;
    const published = owner.acquire({ owner: "published-generation" });
    await published.ready;
    await expect(owner.assertStopped({ reclaimReplayedSelf: true })).rejects.toThrow(
      "Another Gateway owner lease is still active",
    );
    expect(() => owner.acquire({ owner: "next-generation" })).toThrow(
      "Another Gateway owner lease is still active",
    );
    expect(readGatewayOwnerLease({ env })?.owner).toBe("published-generation");
  });

  it("reads the previous owner in place instead of copying the state database", async () => {
    await using owner = fixture();
    const { env } = owner;
    seedOwner(env, { host: "other-gateway-host" });
    await closeOpenClawStateDatabaseAsync();
    const copy = vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocationSync");
    await expect(owner.assertStopped({ reclaimReplayedSelf: true })).rejects.toThrow(
      "owner heartbeat is fresh",
    );
    expect(copy).not.toHaveBeenCalled();
  });

  it.each([
    { label: "foreign host", host: "other-gateway-host" },
    { label: "missing start identity", startedAt: null },
  ])("preserves an unverifiable $label owner", async (previous) => {
    await using owner = fixture();
    const { env } = owner;
    seedOwner(env, previous);
    expect(readGatewayOwnerLease({ env })).toMatchObject({ state: "unknown", expired: false });
    expect(() => owner.acquire()).toThrow(
      previous.label === "foreign host"
        ? "owner heartbeat is fresh"
        : "Another Gateway owner lease is still active",
    );
    expect(readGatewayOwnerLease({ env })?.owner).toBe("previous-generation");
  });

  it("keeps an unreadable process start identity unknown", async () => {
    await using owner = fixture();
    const { env } = owner;
    seedOwner(env);
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    expect(readGatewayOwnerLease({ env })?.state).toBe("unknown");
  });

  it("leaves the database a clone mounts over its path unopened on release", async () => {
    // The guest layout: state/ links to the placeholder's directory until the
    // clone mounts the Owner's state over the same path.
    const root = tempDirs.make("openclaw-gateway-owner-overmount-");
    const placeholder = path.join(root, "placeholder");
    const mounted = path.join(root, "mounted");
    const env = { OPENCLAW_STATE_DIR: path.join(root, "home") };
    fs.mkdirSync(placeholder);
    fs.mkdirSync(mounted);
    fs.mkdirSync(env.OPENCLAW_STATE_DIR);
    const link = path.join(env.OPENCLAW_STATE_DIR, "state");
    fs.symlinkSync(placeholder, link);
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
    try {
      const lease = acquireGatewayOwnerLease({
        env,
        port: 19483,
        mode: "foreground",
        supervisor: null,
      });
      await lease.ready;
      const { DatabaseSync } = requireNodeSqlite();
      const source = new DatabaseSync(databasePath, { readOnly: true });
      try {
        source.exec(`VACUUM INTO '${path.join(mounted, path.basename(databasePath))}'`);
      } finally {
        source.close();
      }
      fs.unlinkSync(link);
      fs.symlinkSync(mounted, link);
      await lease.release();
      expect(readGatewayOwnerLease({ env })?.owner).toBe(lease.owner);
    } finally {
      coordinator.release();
    }
  });

  it("does not delete a replacement generation during an older owner's release", async () => {
    await using owner = fixture();
    const { env } = owner;
    const lease = owner.acquire();
    await lease.ready;
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) => {
        db.prepare(
          "UPDATE state_leases SET owner = 'replacement' WHERE scope = 'gateway-owner'",
        ).run();
      },
      { env },
    );
    expect(() => lease.markListening()).toThrow("owner changed before listening publication");
    expect(readGatewayOwnerLease({ env })?.listeningAt).toBeUndefined();
    await lease.release();
    expect(readGatewayOwnerLease({ env })?.owner).toBe("replacement");
  });
});
