import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

export function clearTaskRegistrySqliteForTests(ownerKind: "flow"): void {
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateDatabase>(db);
      executeSqliteQuerySync(db, kysely.deleteFrom("flow_runs"));
      // Reset selected-family orphans without enabling optional lifecycle metadata.
      if (tableExists(db, "execution_owner_lifecycle_bindings")) {
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("execution_owner_lifecycle_bindings")
            .where("owner_kind", "=", ownerKind),
        );
      }
    });
  } catch (error) {
    const subsystem = "tasks/task-flow-registry";
    createSubsystemLogger(subsystem).warn(`Failed to reset ${ownerKind} registry storage`, {
      error,
    });
  } finally {
    closeOpenClawStateDatabase();
  }
}
