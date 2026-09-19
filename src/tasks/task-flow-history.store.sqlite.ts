// Existing controller history receipts, shared by synchronous and worker flow writes.
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { ensureTaskFlowHistorySchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  TaskFlowHistoryArchive,
  TaskFlowHistoryEvent,
  TaskFlowHistoryPage,
  TaskFlowHistoryRegistration,
} from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { parseSqliteJsonValue } from "./task-registry.sqlite.shared.js";
const TASK_FLOW_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60_000;
const TASK_FLOW_HISTORY_DEFAULT_PAGE_SIZE = 20;
const TASK_FLOW_HISTORY_MAX_PAGE_SIZE = 20;

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

export function recordTaskFlowHistoryInDatabase(
  db: DatabaseSync,
  flow: TaskFlowRecord,
  history?: TaskFlowHistoryRegistration,
): void {
  if (!history && !tableExists(db, "task_flow_history_streams")) {
    return;
  }
  ensureTaskFlowHistorySchema(db);
  const createdStream = ensureTaskFlowHistoryStream(db, flow, history);
  if (createdStream || !history) {
    appendTaskFlowHistoryEvent(db, flow, history);
  }
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
          params.ownerKey,
          params.controllerId,
          cutoff,
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
  runOpenClawStateWriteTransaction(({ db }) => {
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
