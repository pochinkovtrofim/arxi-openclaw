import { clearSessionProgressCardForReset } from "../../session-cards/progress-card-store.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { SessionResetBoundaryWrite } from "./session-accessor.lifecycle-types.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  buildSessionResetBoundaryEvent,
  createSessionResetBoundaryId,
} from "./session-reset-boundary-event.js";
import { resolveResetBoundaryHeaderCwd } from "./transcript-header.js";
import type { InternalSessionEntry } from "./types.js";

/** Transcript reset and prior-task retirement share the owning guarded transaction. */
export function appendSessionResetBoundary(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  previousEntry: InternalSessionEntry,
  boundary: SessionResetBoundaryWrite,
  projection?: {
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
  },
): boolean {
  // Reset may be the first append; a headerless window cannot be read on the next turn.
  ensureTranscriptHeader(
    database,
    scope,
    resolveResetBoundaryHeaderCwd(previousEntry, boundary.cwd),
    projection,
  );
  const inputs = readResetBoundaryInputs(database, scope.sessionId);
  const event = buildSessionResetBoundaryEvent({
    events: inputs.events,
    ...boundary,
    ...(inputs.idTaken
      ? { boundaryId: newResetBoundaryId(boundary.boundaryId, inputs.idTaken) }
      : {}),
  });
  if (appendTranscriptEventInTransaction(database, scope, event, projection) === false) {
    throw new Error("Failed to append reset boundary for " + scope.sessionKey);
  }
  if (
    boundary.context === "clear" &&
    clearSessionProgressCardForReset(database.db, scope.sessionKey)
  ) {
    const { agentId, sessionKey } = scope;
    deferOpenClawAgentPostCommitPublication(database, () => {
      emitSessionLifecycleEvent({ agentId, sessionKey, reason: "progress-card-reset" });
    });
    return true;
  }
  return false;
}

/**
 * A reset names its parent (the last entry) and, when it keeps a tail, the replay records
 * of the latest boundary window. Without branch ("leaf") control both depend only on the
 * rows from that window's first kept entry on, so a window that resets in place on every
 * run (a fresh-context cron session gains one boundary per run, for months) reads that
 * tail, not its whole history, inside the write transaction.
 *
 * The identity index finds the latest boundary, the kept entry and any leaf control:
 * every writer records an identity for each event that has an id, and a leaf control,
 * a boundary and a kept entry are found only by id. A boundary row without an id later
 * in the tail could keep entries from before it, so it reads the whole transcript.
 */
function readResetBoundaryInputs(
  database: OpenClawAgentDatabase,
  sessionId: string,
): { events: TranscriptEvent[]; idTaken?: (id: string) => boolean } {
  const whole = () => ({
    events: loadTranscriptEventsFromDatabase(database, sessionId, {
      projection: "reset-boundary",
    }),
  });
  const db = getSessionKysely(database.db);
  const latestOfType = (types: string[]) =>
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select(["seq", "event_id"])
        .where("session_id", "=", sessionId)
        .where("event_type", "in", types)
        .orderBy("seq", "desc")
        .limit(1),
    );
  const seqOfId = (id: string) =>
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select("seq")
        .where("session_id", "=", sessionId)
        .where("event_id", "=", id),
    )?.seq;
  if (latestOfType(["leaf"])) {
    return whole();
  }
  const boundary = latestOfType(["reset", "compaction"]);
  if (!boundary) {
    return whole();
  }
  const boundarySeq = sqliteNumber(boundary.seq);
  const tailFrom = (seq: number) =>
    loadTranscriptEventsFromDatabase(database, sessionId, {
      projection: "reset-boundary",
      afterEventSeq: seq - 1,
    });
  let events = tailFrom(boundarySeq);
  const head = asOptionalRecord(events[0]);
  const isBoundary = (event: unknown) => {
    const type = asOptionalRecord(event)?.type;
    return type === "reset" || type === "compaction";
  };
  if (
    readNonBlankString(head?.id) !== boundary.event_id ||
    events.findLastIndex(isBoundary) !== 0
  ) {
    return whole();
  }
  const firstKeptEntryId = readNonBlankString(head?.firstKeptEntryId);
  const keptSeq = firstKeptEntryId ? seqOfId(firstKeptEntryId) : undefined;
  if (keptSeq !== undefined && keptSeq !== null && sqliteNumber(keptSeq) < boundarySeq) {
    events = tailFrom(sqliteNumber(keptSeq));
  }
  return { events, idTaken: (id) => seqOfId(id) !== undefined };
}

/** The tail cannot prove an ID unused; the identity index can. */
function newResetBoundaryId(requested: string | undefined, idTaken: (id: string) => boolean) {
  const id = requested?.trim();
  if (id) {
    if (idTaken(id)) {
      throw new Error(`Reset boundary ID already exists: ${id}`);
    }
    return id;
  }
  for (;;) {
    const candidate = createSessionResetBoundaryId();
    if (!idTaken(candidate)) {
      return candidate;
    }
  }
}
