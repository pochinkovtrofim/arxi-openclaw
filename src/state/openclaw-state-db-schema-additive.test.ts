import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";

const trailingSchema = vi.hoisted(() => ({
  tableName: "future_lazy_state",
  sql: "CREATE TABLE IF NOT EXISTS future_lazy_state (id TEXT PRIMARY KEY) STRICT;",
}));

vi.mock("./openclaw-state-schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-schema.js")>();
  return {
    ...actual,
    OPENCLAW_STATE_SCHEMA_SQL: `${actual.OPENCLAW_STATE_SCHEMA_SQL}\n${trailingSchema.sql}\n`,
  };
});

import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  ensureSecretStoreSchema,
  ensureTaskFlowAutomationObligationSchema,
  ensureTaskFlowHistorySchema,
} from "./openclaw-state-db-schema-additive.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";

it("keeps secret-store first use from installing later additive schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    ensureSecretStoreSchema(database);
    const names = database
      .prepare("SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?) ORDER BY name")
      .all("secret_store_entries", "secret_store_entries_live_idx", trailingSchema.tableName)
      .map((row) => row.name);

    expect(names).toEqual(["secret_store_entries", "secret_store_entries_live_idx"]);
  } finally {
    database.close();
  }
});

it("installs task-flow Automation obligations as same-version additive schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
    ensureTaskFlowAutomationObligationSchema(database);
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("task_flow_automation_obligations"),
    ).toEqual({ name: "task_flow_automation_obligations" });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
    ).not.toContain("task_flow_automation_obligations");
  } finally {
    database.close();
  }
});

it("lazily adds allowed_hosts to a v6 secret store without changing user_version", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      PRAGMA user_version = 6;
      CREATE TABLE secret_store_entries (
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        updated_by TEXT,
        deleted_at_ms INTEGER,
        PRIMARY KEY (scope_kind, scope_id, name)
      ) STRICT;
    `);

    ensureSecretStoreSchema(database);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(
      database
        .prepare(
          'SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?) WHERE name = ?',
        )
        .get("secret_store_entries", "allowed_hosts"),
    ).toEqual({ name: "allowed_hosts", type: "TEXT", notnull: 0, dflt_value: null });
  } finally {
    database.close();
  }
});

it("installs task-flow history as same-version additive schema for candidate reopen", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
    ensureTaskFlowHistorySchema(database);

    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'task_flow_history_%'",
        )
        .all()
        .map((row) => row.name)
        .sort(),
    ).toEqual([
      "task_flow_history_archives",
      "task_flow_history_events",
      "task_flow_history_streams",
    ]);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    // The normal same-version runtime projection omits feature-local tables, so
    // a previous reader accepts a database after the candidate has enabled history.
    expect(
      getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
    ).not.toContain("task_flow_history_streams");
  } finally {
    database.close();
  }
});
