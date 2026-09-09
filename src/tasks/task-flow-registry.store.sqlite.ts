// Persists managed task-flow records through the OpenClaw SQLite state database.
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Insertable, Selectable } from "kysely";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  deleteExecutionOwnerLifecycleMetadata,
  pruneOrphanedExecutionOwnerLifecycleMetadata,
} from "../audit/execution-owner-lifecycle-binding-store.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { ensureTaskFlowHistorySchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  TaskFlowHistoryArchive,
  TaskFlowHistoryEvent,
  TaskFlowHistoryPage,
  TaskFlowHistoryRegistration,
  TaskFlowRegistryStoreSnapshot,
} from "./task-flow-registry.store.types.js";
import {
  parseOptionalTaskFlowSyncMode,
  parseTaskFlowStatus,
  type JsonValue,
  type TaskFlowRecord,
  type TaskFlowSyncMode,
} from "./task-flow-registry.types.js";
import { parseDeliveryContextJson, parseSqliteJsonValue } from "./task-registry.sqlite.shared.js";
import { parseTaskNotifyPolicy } from "./task-registry.types.js";

type FlowRunsTable = OpenClawStateKyselyDatabase["flow_runs"];
type FlowRegistryStoreDatabase = Pick<OpenClawStateKyselyDatabase, "flow_runs">;

type FlowRegistryRow = Selectable<FlowRunsTable> & {
  sync_mode: string | null;
  status: string;
  notify_policy: string;
};

type FlowRegistryDatabase = {
  db: DatabaseSync;
  path: string;
};

const TASK_FLOW_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60_000;
const TASK_FLOW_HISTORY_DEFAULT_PAGE_SIZE = 20;
const TASK_FLOW_HISTORY_MAX_PAGE_SIZE = 20;

// SQLite-backed task-flow store mirrors the in-process registry into openclaw-state.db.
let cachedDatabase: FlowRegistryDatabase | null = null;

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function taskFlowHistorySnapshot(flow: TaskFlowRecord): TaskFlowHistoryEvent["snapshot"] {
  return {
    status: flow.status,
    goal: flow.goal,
    ...(flow.currentStep ? { currentStep: flow.currentStep } : {}),
    ...(flow.blockedSummary ? { blockedSummary: flow.blockedSummary } : {}),
    ...(flow.stateJson !== undefined ? { stateJson: flow.stateJson } : {}),
    ...(flow.waitJson !== undefined ? { waitJson: flow.waitJson } : {}),
    ...(flow.endedAt !== undefined ? { endedAt: flow.endedAt } : {}),
  };
}

function digestTaskFlowHistoryEvent(event: Omit<TaskFlowHistoryEvent, "digest">): string {
  return crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

type TaskFlowHistoryCursor =
  | { phase: "events"; occurredAt: number; flowId: string; revision: number }
  | { phase: "archives"; occurredAt: number; flowId: string };

function encodeHistoryCursor(cursor: TaskFlowHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryCursor(cursor: string | undefined): TaskFlowHistoryCursor | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (isRecord(parsed)) {
      const phase = parsed.phase;
      const revision = parsed.revision;
      const occurredAt = parsed.occurredAt;
      const flowId = parsed.flowId;
      if (
        phase === "archives" &&
        typeof occurredAt === "number" &&
        typeof flowId === "string" &&
        flowId.length > 0 &&
        Number.isSafeInteger(occurredAt)
      ) {
        return { phase, occurredAt, flowId };
      }
      if (
        phase === "events" &&
        typeof revision === "number" &&
        typeof occurredAt === "number" &&
        typeof flowId === "string" &&
        flowId.length > 0 &&
        Number.isSafeInteger(revision) &&
        Number.isSafeInteger(occurredAt) &&
        revision >= 0
      ) {
        return {
          phase,
          occurredAt,
          flowId,
          revision,
        };
      }
    }
  } catch {
    // Treat malformed cursors as an empty result rather than widening the query.
  }
  return { phase: "events", occurredAt: -1, flowId: "", revision: -1 };
}

function normalizeHistoryPageSize(limit: number | undefined): number {
  if (limit === undefined) {
    return TASK_FLOW_HISTORY_DEFAULT_PAGE_SIZE;
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Task Flow history page limit must be a positive integer.");
  }
  return Math.min(limit, TASK_FLOW_HISTORY_MAX_PAGE_SIZE);
}

function emptyTaskFlowHistoryPage(now = Date.now()): TaskFlowHistoryPage {
  return {
    retentionDays: 90,
    availableSince: now - TASK_FLOW_HISTORY_RETENTION_MS,
    events: [],
    archives: [],
  };
}

function resolveFlowSyncMode(row: {
  sync_mode: string | null;
  shape: string | null;
}): TaskFlowSyncMode {
  // Older single_task rows did not persist sync_mode; preserve their mirrored semantics.
  const syncMode = parseOptionalTaskFlowSyncMode(row.sync_mode);
  if (syncMode) {
    return syncMode;
  }
  return row.shape === "single_task" ? "task_mirrored" : "managed";
}

function rowToSyncMode(row: FlowRegistryRow): TaskFlowSyncMode {
  return resolveFlowSyncMode(row);
}

function isFlowExecutionOwnerActive(row: {
  sync_mode: string | null;
  shape: string | null;
  status: string;
  cancel_requested_at: number | null;
  ended_at: number | null;
}): boolean {
  const syncMode = resolveFlowSyncMode(row);
  const status = parseTaskFlowStatus(row.status);
  if (row.cancel_requested_at !== null || row.ended_at !== null) {
    return false;
  }
  // Mirrored `blocked` is derived from a terminal task; managed `blocked`
  // remains live while its controller waits for the blocking task.
  return syncMode === "task_mirrored"
    ? status === "queued" || status === "running"
    : status === "queued" || status === "running" || status === "waiting" || status === "blocked";
}

function rowToFlowRecord(row: FlowRegistryRow): TaskFlowRecord {
  const endedAt = normalizeSqliteNumber(row.ended_at);
  const cancelRequestedAt = normalizeSqliteNumber(row.cancel_requested_at);
  const requesterOrigin = parseDeliveryContextJson(row.requester_origin_json);
  const stateJson = parseSqliteJsonValue<JsonValue>(row.state_json);
  const waitJson = parseSqliteJsonValue<JsonValue>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeSqliteNumber(row.revision) ?? 0,
    status: parseTaskFlowStatus(row.status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
    ...(waitJson !== undefined ? { waitJson } : {}),
    ...(cancelRequestedAt != null ? { cancelRequestedAt } : {}),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}

function bindFlowRecord(record: TaskFlowRecord): Insertable<FlowRunsTable> {
  return {
    flow_id: record.flowId,
    sync_mode: record.syncMode,
    shape: null,
    owner_key: record.ownerKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    controller_id: record.controllerId ?? null,
    revision: record.revision,
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    state_json: serializeJson(record.stateJson),
    wait_json: serializeJson(record.waitJson),
    cancel_requested_at: record.cancelRequestedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
  };
}

function getFlowRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<FlowRegistryStoreDatabase>(db);
}

function pruneFlowsNotInSnapshot(params: { db: DatabaseSync; ids: readonly string[] }) {
  const tempTableName = "openclaw_live_flow_ids";
  params.db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${tempTableName} (id TEXT PRIMARY KEY)`);
  params.db.exec(`DELETE FROM ${tempTableName}`);
  const insert = params.db.prepare(`INSERT OR IGNORE INTO ${tempTableName} (id) VALUES (?)`);
  for (const id of params.ids) {
    insert.run(id);
  }
  params.db.exec(`
    DELETE FROM flow_runs
    WHERE NOT EXISTS (
      SELECT 1 FROM ${tempTableName}
      WHERE ${tempTableName}.id = flow_runs.flow_id
    )
  `);
  params.db.exec(`DELETE FROM ${tempTableName}`);
}

function selectFlowRows(db: DatabaseSync): FlowRegistryRow[] {
  const query = getFlowRegistryKysely(db)
    .selectFrom("flow_runs")
    .select([
      "flow_id",
      "sync_mode",
      "shape",
      "owner_key",
      "requester_origin_json",
      "controller_id",
      "revision",
      "status",
      "notify_policy",
      "goal",
      "current_step",
      "blocked_task_id",
      "blocked_summary",
      "state_json",
      "wait_json",
      "cancel_requested_at",
      "created_at",
      "updated_at",
      "ended_at",
    ])
    .orderBy("created_at", "asc")
    .orderBy("flow_id", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

function upsertFlowRow(db: DatabaseSync, row: Insertable<FlowRunsTable>): void {
  executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .insertInto("flow_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("flow_id").doUpdateSet({
          sync_mode: (eb) => eb.ref("excluded.sync_mode"),
          owner_key: (eb) => eb.ref("excluded.owner_key"),
          requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
          controller_id: (eb) => eb.ref("excluded.controller_id"),
          revision: (eb) => eb.ref("excluded.revision"),
          status: (eb) => eb.ref("excluded.status"),
          notify_policy: (eb) => eb.ref("excluded.notify_policy"),
          goal: (eb) => eb.ref("excluded.goal"),
          current_step: (eb) => eb.ref("excluded.current_step"),
          blocked_task_id: (eb) => eb.ref("excluded.blocked_task_id"),
          blocked_summary: (eb) => eb.ref("excluded.blocked_summary"),
          state_json: (eb) => eb.ref("excluded.state_json"),
          wait_json: (eb) => eb.ref("excluded.wait_json"),
          cancel_requested_at: (eb) => eb.ref("excluded.cancel_requested_at"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
        }),
      ),
  );
}

function findTaskFlowHistoryStream(
  db: DatabaseSync,
  flowId: string,
): { ownerKey: string; controllerId: string } | undefined {
  // SAFETY: this fixed query selects only these two SQLite columns; values are runtime-validated below.
  const row = db
    .prepare("SELECT owner_key, controller_id FROM task_flow_history_streams WHERE flow_id = ?")
    .get(flowId) as { owner_key?: unknown; controller_id?: unknown } | undefined; // SAFETY: fixed query columns are runtime-validated below.
  if (!row || typeof row.owner_key !== "string" || typeof row.controller_id !== "string") {
    return undefined;
  }
  return { ownerKey: row.owner_key, controllerId: row.controller_id };
}

function appendTaskFlowHistoryEvent(
  db: DatabaseSync,
  flow: TaskFlowRecord,
  history?: TaskFlowHistoryRegistration,
): void {
  const stream = findTaskFlowHistoryStream(db, flow.flowId);
  if (!stream) {
    return;
  }
  if (stream.ownerKey !== flow.ownerKey || stream.controllerId !== flow.controllerId) {
    throw new Error(`Task Flow history stream identity mismatch for ${flow.flowId}.`);
  }
  const event: Omit<TaskFlowHistoryEvent, "digest"> = {
    flowId: flow.flowId,
    revision: flow.revision,
    occurredAt: history?.enabledAt ?? flow.updatedAt,
    eventType:
      history?.enabledAt !== undefined ? "enabled" : flow.revision === 0 ? "created" : "transition",
    snapshot: taskFlowHistorySnapshot(flow),
  };
  const digest = digestTaskFlowHistoryEvent(event);
  const encoded = JSON.stringify(event.snapshot);
  // SAFETY: this fixed query selects only digest; the value is compared before reuse.
  const existing = db
    .prepare("SELECT digest FROM task_flow_history_events WHERE flow_id = ? AND revision = ?")
    .get(flow.flowId, flow.revision) as { digest?: unknown } | undefined; // SAFETY: fixed query digest is compared before reuse.
  if (existing) {
    if (existing.digest !== digest) {
      throw new Error(`Task Flow history revision collision for ${flow.flowId}.`);
    }
    return;
  }
  db.prepare(
    `INSERT INTO task_flow_history_events
      (flow_id, revision, occurred_at, event_type, event_json, digest)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(flow.flowId, flow.revision, event.occurredAt, event.eventType, encoded, digest);
}

function ensureTaskFlowHistoryStream(
  db: DatabaseSync,
  flow: TaskFlowRecord,
  history: TaskFlowHistoryRegistration | undefined,
): boolean {
  if (!history) {
    return false;
  }
  if (flow.syncMode !== "managed" || flow.controllerId !== history.controllerId) {
    throw new Error("Task Flow history must be registered for the managed flow controller.");
  }
  const existing = findTaskFlowHistoryStream(db, flow.flowId);
  if (existing) {
    if (existing.ownerKey !== flow.ownerKey || existing.controllerId !== history.controllerId) {
      throw new Error(`Task Flow history stream identity mismatch for ${flow.flowId}.`);
    }
    return false;
  }
  db.prepare(
    `INSERT INTO task_flow_history_streams (flow_id, owner_key, controller_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(flow.flowId, flow.ownerKey, history.controllerId, flow.createdAt);
  return true;
}

function upsertFlowWithHistory(
  db: DatabaseSync,
  flow: TaskFlowRecord,
  history?: TaskFlowHistoryRegistration,
): void {
  if (history || tableExists(db, "task_flow_history_streams")) {
    ensureTaskFlowHistorySchema(db);
    const createdStream = ensureTaskFlowHistoryStream(db, flow, history);
    upsertFlowRow(db, bindFlowRecord(flow));
    if (createdStream || !history) {
      appendTaskFlowHistoryEvent(db, flow, history);
    }
    return;
  }
  upsertFlowRow(db, bindFlowRecord(flow));
}

function openFlowRegistryDatabase(): FlowRegistryDatabase {
  const database = openOpenClawStateDatabase();
  const pathname = database.path;
  if (cachedDatabase && cachedDatabase.path === pathname && cachedDatabase.db.isOpen) {
    return cachedDatabase;
  }
  if (cachedDatabase && !cachedDatabase.db.isOpen) {
    cachedDatabase = null;
  }
  cachedDatabase = {
    db: database.db,
    path: pathname,
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (database: FlowRegistryDatabase) => void) {
  const database = openFlowRegistryDatabase();
  runOpenClawStateWriteTransaction(() => {
    write(database);
  });
}

export function loadTaskFlowRegistryStateFromSqlite(): TaskFlowRegistryStoreSnapshot {
  const { db } = openFlowRegistryDatabase();
  const rows = selectFlowRows(db);
  return {
    flows: new Map(rows.map((row) => [row.flow_id, rowToFlowRecord(row)])),
  };
}

/** Loads task flows without creating or migrating shared state. */
export function loadTaskFlowRegistryStateFromSqliteReadOnly(): TaskFlowRegistryStoreSnapshot {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      const rows = selectFlowRows(db);
      return {
        flows: new Map(rows.map((row) => [row.flow_id, rowToFlowRecord(row)])),
      };
    }) ?? { flows: new Map() }
  );
}

export function saveTaskFlowRegistryStateToSqlite(snapshot: TaskFlowRegistryStoreSnapshot) {
  withWriteTransaction(({ db }) => {
    const kysely = getFlowRegistryKysely(db);
    const flowIds = [...snapshot.flows.keys()];
    if (flowIds.length === 0) {
      executeSqliteQuerySync(db, kysely.deleteFrom("flow_runs"));
      pruneOrphanedExecutionOwnerLifecycleMetadata(db, "flow");
      return;
    }
    pruneFlowsNotInSnapshot({ db, ids: flowIds });
    for (const flow of snapshot.flows.values()) {
      upsertFlowRow(db, bindFlowRecord(flow));
    }
    pruneOrphanedExecutionOwnerLifecycleMetadata(db, "flow");
  });
}

export function upsertTaskFlowRegistryRecordToSqlite(flow: TaskFlowRecord) {
  upsertTaskFlowRegistryRecordWithHistoryToSqlite(flow);
}

/** Writes the current Flow and its opted-in transition receipt in one SQLite transaction. */
export function upsertTaskFlowRegistryRecordWithHistoryToSqlite(
  flow: TaskFlowRecord,
  history?: TaskFlowHistoryRegistration,
) {
  withWriteTransaction(({ db }) => {
    upsertFlowWithHistory(db, flow, history);
  });
}

function parseTaskFlowHistoryEvent(row: Record<string, unknown>): TaskFlowHistoryEvent | undefined {
  if (
    typeof row.flow_id !== "string" ||
    typeof row.revision !== "number" ||
    typeof row.occurred_at !== "number" ||
    (row.event_type !== "created" &&
      row.event_type !== "enabled" &&
      row.event_type !== "transition") ||
    typeof row.event_json !== "string" ||
    typeof row.digest !== "string"
  ) {
    return undefined;
  }
  const snapshot = parseSqliteJsonValue<TaskFlowHistoryEvent["snapshot"]>(row.event_json);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return undefined;
  }
  return {
    flowId: row.flow_id,
    revision: row.revision,
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    digest: row.digest,
    snapshot,
  };
}

function parseTaskFlowHistoryArchive(
  row: Record<string, unknown>,
): TaskFlowHistoryArchive | undefined {
  if (
    typeof row.flow_id !== "string" ||
    typeof row.first_revision !== "number" ||
    typeof row.last_revision !== "number" ||
    typeof row.first_occurred_at !== "number" ||
    typeof row.last_occurred_at !== "number" ||
    typeof row.event_count !== "number" ||
    typeof row.digest !== "string"
  ) {
    return undefined;
  }
  return {
    flowId: row.flow_id,
    firstRevision: row.first_revision,
    lastRevision: row.last_revision,
    firstOccurredAt: row.first_occurred_at,
    lastOccurredAt: row.last_occurred_at,
    eventCount: row.event_count,
    digest: row.digest,
  };
}

/** Reads only the controller timeline that belongs to the bound owner/session. */
export function listTaskFlowHistoryForOwnerFromSqlite(params: {
  flowId?: string;
  ownerKey: string;
  controllerId: string;
  cursor?: string;
  limit?: number;
}): TaskFlowHistoryPage {
  const beforeRevision = decodeHistoryCursor(params.cursor);
  const limit = normalizeHistoryPageSize(params.limit);
  if (beforeRevision?.phase === "events" && beforeRevision.revision === -1) {
    return emptyTaskFlowHistoryPage();
  }
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "task_flow_history_streams")) {
        return emptyTaskFlowHistoryPage();
      }
      const cutoff = Date.now() - TASK_FLOW_HISTORY_RETENTION_MS;
      const flowFilter = params.flowId ? " AND stream.flow_id = ?" : "";
      if (beforeRevision?.phase === "archives") {
        const archiveRows = db
          .prepare(
            `SELECT archive.flow_id, archive.first_revision, archive.last_revision,
                    archive.first_occurred_at, archive.last_occurred_at, archive.event_count, archive.digest
             FROM task_flow_history_archives archive
             JOIN task_flow_history_streams stream ON stream.flow_id = archive.flow_id
             WHERE stream.owner_key = ? AND stream.controller_id = ?${params.flowId ? " AND archive.flow_id = ?" : ""}
               AND (archive.last_occurred_at < ? OR
                    (archive.last_occurred_at = ? AND archive.flow_id < ?))
             ORDER BY archive.last_occurred_at DESC, archive.flow_id DESC
             LIMIT ?`,
          )
          .all(
            params.ownerKey,
            params.controllerId,
            ...(params.flowId ? [params.flowId] : []),
            beforeRevision.occurredAt,
            beforeRevision.occurredAt,
            beforeRevision.flowId,
            limit + 1,
          );
        const parsedArchives = archiveRows
          .map((row) => parseTaskFlowHistoryArchive(row))
          .filter((archive): archive is TaskFlowHistoryArchive => Boolean(archive));
        const hasMore = parsedArchives.length > limit;
        const archives = hasMore ? parsedArchives.slice(0, limit) : parsedArchives;
        const last = archives.at(-1);
        return {
          retentionDays: 90,
          availableSince: cutoff,
          events: [],
          archives,
          ...(hasMore && last
            ? {
                nextCursor: encodeHistoryCursor({
                  phase: "archives",
                  occurredAt: last.lastOccurredAt,
                  flowId: last.flowId,
                }),
              }
            : {}),
        };
      }
      const cursorFilter =
        beforeRevision === undefined
          ? ""
          : ` AND (event.occurred_at < ? OR (event.occurred_at = ? AND
               (event.flow_id < ? OR (event.flow_id = ? AND event.revision < ?))))`;
      const eventRows = db
        .prepare(
          `SELECT event.flow_id, event.revision, event.occurred_at, event.event_type, event.event_json, event.digest
           FROM task_flow_history_events event
           JOIN task_flow_history_streams stream ON stream.flow_id = event.flow_id
           WHERE stream.owner_key = ? AND stream.controller_id = ? AND event.occurred_at >= ?${flowFilter}${cursorFilter}
           ORDER BY event.occurred_at DESC, event.flow_id DESC, event.revision DESC
           LIMIT ?`,
        )
        .all(
          ...[params.ownerKey, params.controllerId, cutoff],
          ...(params.flowId ? [params.flowId] : []),
          ...(beforeRevision === undefined
            ? []
            : [
                beforeRevision.occurredAt,
                beforeRevision.occurredAt,
                beforeRevision.flowId,
                beforeRevision.flowId,
                beforeRevision.revision,
              ]),
          limit + 1,
        );
      const parsedEvents = eventRows
        .map((row) => parseTaskFlowHistoryEvent(row))
        .filter((event): event is TaskFlowHistoryEvent => Boolean(event));
      const hasMore = parsedEvents.length > limit;
      const events = hasMore ? parsedEvents.slice(0, limit) : parsedEvents;
      const last = events.at(-1);
      const hasArchives =
        !hasMore &&
        Boolean(
          db
            .prepare(
              `SELECT 1 FROM task_flow_history_archives archive
               JOIN task_flow_history_streams stream ON stream.flow_id = archive.flow_id
               WHERE stream.owner_key = ? AND stream.controller_id = ?${params.flowId ? " AND archive.flow_id = ?" : ""}
               LIMIT 1`,
            )
            .get(params.ownerKey, params.controllerId, ...(params.flowId ? [params.flowId] : [])),
        );
      return {
        retentionDays: 90,
        availableSince: cutoff,
        events,
        archives: [],
        ...(hasMore && last
          ? {
              nextCursor: encodeHistoryCursor({
                phase: "events",
                occurredAt: last.occurredAt,
                flowId: last.flowId,
                revision: last.revision,
              }),
            }
          : hasArchives
            ? {
                nextCursor: encodeHistoryCursor({
                  phase: "archives",
                  occurredAt: Number.MAX_SAFE_INTEGER,
                  flowId: "\uffff",
                }),
              }
            : {}),
      };
    }) ?? emptyTaskFlowHistoryPage()
  );
}

/** Converts expired detail into a content-free range/count/digest receipt. */
export function pruneTaskFlowHistoryFromSqlite(now = Date.now()): number {
  const cutoff = now - TASK_FLOW_HISTORY_RETENTION_MS;
  let pruned = 0;
  withWriteTransaction(({ db }) => {
    if (!tableExists(db, "task_flow_history_events")) {
      return;
    }
    // SAFETY: this fixed query selects the declared stream columns from STRICT tables.
    const streams = db
      .prepare(
        `SELECT DISTINCT stream.flow_id, stream.owner_key
         FROM task_flow_history_streams stream
         JOIN task_flow_history_events event ON event.flow_id = stream.flow_id
         WHERE event.occurred_at < ?`,
      )
      .all(cutoff) as { flow_id: string; owner_key: string }[]; // SAFETY: fixed query selects declared STRICT stream columns.
    for (const stream of streams) {
      // SAFETY: this fixed query selects numeric/text event receipt fields from STRICT tables.
      const events = db
        .prepare(
          `SELECT revision, occurred_at, digest FROM task_flow_history_events
           WHERE flow_id = ? AND occurred_at < ?
           ORDER BY revision ASC`,
        )
        .all(stream.flow_id, cutoff) as { revision: number; occurred_at: number; digest: string }[]; // SAFETY: fixed query selects declared STRICT receipt fields.
      if (events.length === 0) {
        continue;
      }
      // SAFETY: this fixed query selects the archive receipt shape written below in this transaction.
      const existing = db
        .prepare(
          `SELECT first_revision, last_revision, first_occurred_at, last_occurred_at, event_count, digest
           FROM task_flow_history_archives WHERE flow_id = ?`,
        )
        .get(stream.flow_id) as // SAFETY: fixed query selects the receipt shape written below.
        | {
            first_revision: number;
            last_revision: number;
            first_occurred_at: number;
            last_occurred_at: number;
            event_count: number;
            digest: string;
          }
        | undefined;
      const first = events[0]!;
      const last = events.at(-1)!;
      const digest = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            previous: existing?.digest ?? null,
            events: events.map((event) => event.digest),
          }),
        )
        .digest("hex");
      db.prepare(
        `INSERT INTO task_flow_history_archives
          (flow_id, owner_key, first_revision, last_revision, first_occurred_at, last_occurred_at, event_count, digest, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(flow_id) DO UPDATE SET
           first_revision = excluded.first_revision,
           last_revision = excluded.last_revision,
           first_occurred_at = excluded.first_occurred_at,
           last_occurred_at = excluded.last_occurred_at,
           event_count = excluded.event_count,
           digest = excluded.digest,
           archived_at = excluded.archived_at`,
      ).run(
        stream.flow_id,
        stream.owner_key,
        existing?.first_revision ?? first.revision,
        last.revision,
        existing?.first_occurred_at ?? first.occurred_at,
        last.occurred_at,
        (existing?.event_count ?? 0) + events.length,
        digest,
        now,
      );
      db.prepare("DELETE FROM task_flow_history_events WHERE flow_id = ? AND occurred_at < ?").run(
        stream.flow_id,
        cutoff,
      );
      pruned += events.length;
    }
  });
  return pruned;
}

/** Binds only the exact flow selected before admission; lifecycle settlement stays owner-native. */
export function bindTaskFlowExecution(params: {
  admitted: AdmittedRunContext;
  flowId: string;
  options?: OpenClawStateDatabaseOptions;
}): ExecutionOwnerBindingResult {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getFlowRegistryKysely(db);
      const current = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("flow_runs")
          .select(["flow_id", "sync_mode", "shape", "status", "cancel_requested_at", "ended_at"])
          .where("flow_id", "=", params.flowId),
      );
      if (!current || !isFlowExecutionOwnerActive(current)) {
        return "missing";
      }
      return bindExecutionOwnerLifecycleMetadata({
        db,
        ownerKind: "flow",
        ownerId: current.flow_id,
        binding,
      });
    },
    params.options,
    { operationLabel: "task.flow.execution-binding" },
  );
}

export function deleteTaskFlowRegistryRecordFromSqlite(flowId: string) {
  withWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getFlowRegistryKysely(db).deleteFrom("flow_runs").where("flow_id", "=", flowId),
    );
    deleteExecutionOwnerLifecycleMetadata({ db, ownerKind: "flow", ownerIds: [flowId] });
  });
}

export function closeTaskFlowRegistryDatabase() {
  cachedDatabase = null;
  closeOpenClawStateDatabase();
}
