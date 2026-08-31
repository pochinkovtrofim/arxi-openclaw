import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { resolveUserPath } from "../../utils.js";

const ARXI_SECRET_STORE_DATABASE = "openclaw-secrets.sqlite";

export function resolveSecretStoreDatabase(
  database?: OpenClawStateDatabaseOptions,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawStateDatabaseOptions {
  if (database) {
    return database;
  }
  const credentialLease = env.ARXI_AUTH_AGENT_DIR?.trim();
  return credentialLease
    ? { path: path.join(resolveUserPath(credentialLease, env), ARXI_SECRET_STORE_DATABASE), env }
    : {};
}
