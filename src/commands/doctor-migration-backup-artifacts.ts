import fs from "node:fs";
import path from "node:path";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  canonicalMigrationFilePath,
  hasSymbolicLinkInDirectoryPath,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";

/** Record the producer's verified originals in the existing recovery inventory. */
export function recordDoctorMigrationBackups(
  env: NodeJS.ProcessEnv,
  backupId: string,
  inventory: readonly { path: string; identity: fs.BigIntStats }[],
): void {
  const runId = `startup-migration-${backupId}`;
  const manifestPath = path.join(resolveSessionSqliteMigrationRunsDir(env), `${runId}.json`);
  if (hasSymbolicLinkInDirectoryPath(path.dirname(manifestPath))) {
    throw new Error("Migration backup manifest directory is aliased");
  }
  if (fs.existsSync(manifestPath)) {
    if (!readSessionSqliteMigrationManifest(manifestPath)) {
      throw new Error(`Cannot read migration backup manifest: ${manifestPath}`);
    }
    return;
  }
  const targets: SessionSqliteMigrationTargetManifest[] = inventory.map(
    ({ path: source, identity }) => {
      const move = {
        kind: "database-backup" as const,
        sourcePath: source,
        archivePath: `${source}.pre-startup-migration-${backupId}.bak`,
        artifact: {
          identity: readMigrationArtifactIdentity(
            `${source}.pre-startup-migration-${backupId}.bak`,
          ),
          classification: "repair-original" as const,
          reason: "pre-startup-migration-backup",
          dependencies: [],
          disposal: { state: "retained" as const },
        },
      };
      return {
        agentId: "startup-migration",
        storePath: source,
        sqlitePath: source,
        databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) },
        plannedMoves: [move],
        completedMoves: [move],
        issues: [],
        validationBeforeArchive: "not_run",
      };
    },
  );
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  writeSessionSqliteMigrationManifest({
    manifestPath,
    manifest: {
      manifestVersion: 3,
      runId,
      openClawVersion: VERSION,
      startedAt: new Date().toISOString(),
      targets,
    },
  });
}

/** Called only after Doctor's database readiness owner verifies the whole fleet. */
export function completeDoctorMigrationBackups(
  env: NodeJS.ProcessEnv,
  verifiedDatabasePaths: readonly string[],
): void {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    return;
  }
  const verified = new Set(
    [...verifiedDatabasePaths, resolveOpenClawStateSqlitePath(env)].map(canonicalMigrationFilePath),
  );
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (
      !manifest ||
      manifest.completedAt ||
      !manifest.targets.length ||
      !manifest.targets.every(({ databaseIdentity, sqlitePath }) => {
        if (!databaseIdentity || !verified.has(sqlitePath)) {
          return false;
        }
        const current = fs.lstatSync(sqlitePath, { bigint: true, throwIfNoEntry: false });
        return (
          current?.isFile() &&
          current.nlink === 1n &&
          String(current.dev) === databaseIdentity.dev &&
          String(current.ino) === databaseIdentity.ino
        );
      })
    ) {
      continue;
    }
    maintenance.assertAdmission();
    for (const target of manifest.targets) {
      target.validationBeforeArchive = "passed";
    }
    manifest.completedAt = new Date().toISOString();
    writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  }
}

const STARTUP_MIGRATION_BACKUP_NAME =
  /^(.+)\.pre-startup-migration-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.bak$/u;

/**
 * Older Doctor builds left pre-migration backup groups without a recovery manifest, so
 * `update cleanup` can never release them. An unrecorded group is superseded once every
 * database it holds has a later verified startup migration group that started after the
 * group was written. The whole group is retired together, because the registry rolls back
 * with its agent databases. Called only after Doctor verified the repaired state.
 */
export function retireUnrecordedStartupMigrationBackups(params: {
  env: NodeJS.ProcessEnv;
  runStartedAtMs: number;
  assertCurrent: () => void;
}): { retired: string[]; warnings: string[] } {
  const retired: string[] = [];
  const warnings: string[] = [];
  const recorded = new Set<string>();
  const supersededAt = new Map<string, number>();
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(params.env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (!manifest) {
      // An unreadable receipt may own any backup; retire nothing.
      return { retired, warnings: [`Cannot read migration backup manifest: ${manifestPath}`] };
    }
    for (const target of manifest.targets) {
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        recorded.add(canonicalMigrationFilePath(move.archivePath));
      }
    }
    if (manifest.runId.startsWith("startup-migration-") && manifest.completedAt) {
      const startedAt = Math.min(Date.parse(manifest.startedAt) || 0, params.runStartedAtMs);
      for (const target of manifest.targets) {
        const database = canonicalMigrationFilePath(target.sqlitePath);
        supersededAt.set(database, Math.max(supersededAt.get(database) ?? 0, startedAt));
      }
    }
  }
  // Scan every agent database directory too, so a group member whose database had no later
  // migration keeps the whole group.
  const sharedPath = resolveOpenClawStateSqlitePath(params.env);
  const stateDir = path.dirname(path.dirname(sharedPath));
  const agentsDir = path.join(stateDir, "agents");
  const agentDirectories = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).map((agentId) => path.join(agentsDir, agentId, "agent"))
    : [];
  const groups = new Map<string, { backupPath: string; database: string }[]>();
  for (const directory of new Set([
    ...[...supersededAt.keys(), canonicalMigrationFilePath(sharedPath)].map((file) =>
      path.dirname(file),
    ),
    ...agentDirectories.map((directory) => canonicalMigrationFilePath(directory)),
  ])) {
    if (!fs.existsSync(directory)) {
      continue;
    }
    for (const name of fs.readdirSync(directory).toSorted()) {
      const match = STARTUP_MIGRATION_BACKUP_NAME.exec(name);
      const backupPath = path.join(directory, name);
      if (match && !recorded.has(backupPath)) {
        const group = groups.get(match[2]!) ?? [];
        group.push({ backupPath, database: path.join(directory, match[1]!) });
        groups.set(match[2]!, group);
      }
    }
  }
  for (const group of groups.values()) {
    try {
      const superseded = group.every(({ backupPath, database }) => {
        const stat = fs.lstatSync(backupPath);
        return (
          stat.isFile() &&
          stat.nlink === 1 &&
          stat.mtimeMs < (supersededAt.get(database) ?? 0)
        );
      });
      if (!superseded) {
        continue;
      }
      for (const { backupPath } of group) {
        params.assertCurrent();
        fs.unlinkSync(backupPath);
        retired.push(backupPath);
      }
    } catch (error) {
      warnings.push(
        `Pre-migration SQLite backup group retained at ${group[0]!.backupPath}: ${String(error)}`,
      );
    }
  }
  return { retired, warnings };
}
