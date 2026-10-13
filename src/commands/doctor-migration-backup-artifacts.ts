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
  /^(.+)\.pre-startup-migration-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bak$/u;

/**
 * Older Doctor builds left pre-migration backups without a recovery manifest, so
 * `update cleanup` can never release them. Once a later startup migration group is
 * verified complete, an unrecorded backup of the same database written before that
 * group started is superseded. Called only after Doctor verified the repaired state.
 */
export function retireUnrecordedStartupMigrationBackups(params: {
  env: NodeJS.ProcessEnv;
  runStartedAtMs: number;
  assertCurrent: () => void;
}): { retired: string[]; warnings: string[] } {
  const retired: string[] = [];
  const warnings: string[] = [];
  const recorded = new Set<string>();
  const databases = new Set<string>();
  let supersededBeforeMs = 0;
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
      supersededBeforeMs = Math.max(supersededBeforeMs, Date.parse(manifest.startedAt) || 0);
      for (const target of manifest.targets) {
        databases.add(canonicalMigrationFilePath(target.sqlitePath));
      }
    }
  }
  supersededBeforeMs = Math.min(supersededBeforeMs, params.runStartedAtMs);
  if (supersededBeforeMs === 0) {
    return { retired, warnings };
  }
  for (const directory of new Set([...databases].map((database) => path.dirname(database)))) {
    for (const name of fs.readdirSync(directory).toSorted()) {
      const backupPath = path.join(directory, name);
      const database = STARTUP_MIGRATION_BACKUP_NAME.exec(name)?.[1];
      if (!database || !databases.has(path.join(directory, database)) || recorded.has(backupPath)) {
        continue;
      }
      try {
        const stat = fs.lstatSync(backupPath);
        if (!stat.isFile() || stat.nlink !== 1 || stat.mtimeMs >= supersededBeforeMs) {
          continue;
        }
        params.assertCurrent();
        fs.unlinkSync(backupPath);
        retired.push(backupPath);
      } catch (error) {
        warnings.push(`Pre-migration SQLite backup retained at ${backupPath}: ${String(error)}`);
      }
    }
  }
  return { retired, warnings };
}
