import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as sqliteIntegrity from "../infra/sqlite-integrity.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

/** A sealed state database whose next runtime open starts a fresh generation, as after a restart. */
function sealedState() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-startup-integrity-proof-") };
  runOpenClawStateWriteTransaction(() => undefined, { env });
  closeOpenClawStateDatabaseForTest();
  return { env, check: vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity") };
}

describe("startup integrity proof", () => {
  it("checks a fresh runtime generation without a startup check", () => {
    const { env, check } = sealedState();

    runOpenClawStateWriteTransaction(() => undefined, { env });

    expect(check).toHaveBeenCalledTimes(1);
  });

  it("lets the runtime's first open reuse the startup checkpoint's full check", () => {
    const { env, check } = sealedState();

    withOpenClawStateStartupMigrationCheckpointDatabase(() => undefined, { env });
    runOpenClawStateWriteTransaction(() => undefined, { env });
    closeOpenClawStateDatabaseForTest();
    runOpenClawStateWriteTransaction(() => undefined, { env });

    // The proof covers one open: the generation after the next close checks again.
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("checks again after a schema change between the two opens", () => {
    const { env, check } = sealedState();

    withOpenClawStateStartupMigrationCheckpointDatabase(() => undefined, { env });
    const { DatabaseSync } = requireNodeSqlite();
    const other = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    other.exec("CREATE TABLE startup_proof_probe (id INTEGER); DROP TABLE startup_proof_probe;");
    other.close();
    runOpenClawStateWriteTransaction(() => undefined, { env });

    expect(check).toHaveBeenCalledTimes(2);
  });

  it("checks again when the startup check is older than 30 seconds", () => {
    const { env, check } = sealedState();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    withOpenClawStateStartupMigrationCheckpointDatabase(() => undefined, { env });
    clock.mockReturnValue(now + 30_001);
    runOpenClawStateWriteTransaction(() => undefined, { env });

    expect(check).toHaveBeenCalledTimes(2);
  });
});
