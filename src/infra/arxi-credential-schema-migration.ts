import fs from "node:fs";
import path from "node:path";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

/** Upgrade the explicitly imported auth lease without treating it as an owner session store. */
export async function migrateArxiCredentialSchema(
  env: NodeJS.ProcessEnv,
  maintenance: OpenClawStateLeaseContext,
): Promise<boolean> {
  const directory = env.ARXI_AUTH_SCHEMA_MIGRATION_DIR?.trim();
  if (!directory) {
    return false;
  }
  if (!path.isAbsolute(directory)) {
    throw new Error("Arxi credential database requires an absolute directory");
  }
  const pathname = path.join(directory, "openclaw-agent.sqlite");
  let info: fs.Stats;
  try {
    info = fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new Error("Arxi credential database must be a regular file");
  }
  const database = openNodeSqliteDatabase(pathname, { readOnly: true });
  let previous: number;
  try {
    previous = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (previous === OPENCLAW_AGENT_SCHEMA_VERSION) {
      return false;
    }
    // This migration owns credentials only. A session-bearing database must go
    // through Doctor's normal media/archive migration, never this special path.
    for (const name of ["session_nodes", "transcript_events"]) {
      const exists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
      if (exists && database.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()) {
        throw new Error("Arxi credential database unexpectedly contains session state");
      }
    }
  } finally {
    database.close();
  }
  await migrateOpenClawAgentDatabaseForMaintenance({ agentId: "main", pathname }, maintenance);
  const verified = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    if (
      Number(verified.prepare("PRAGMA user_version").get()?.user_version) !==
      OPENCLAW_AGENT_SCHEMA_VERSION
    ) {
      throw new Error("Arxi credential database schema did not converge");
    }
  } finally {
    verified.close();
  }
  return previous < OPENCLAW_AGENT_SCHEMA_VERSION;
}
