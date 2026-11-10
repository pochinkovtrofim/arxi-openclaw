import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { transcriptEventModelNavigationSql } from "./transcript-payload.js";
import { isCanonicalSessionTranscriptEntry } from "./transcript-tree.js";

/** Rows read backward to find the newest boundary and the first entry it keeps. */
const SUFFIX_ROW_LIMIT = 4096;
/** Active-path rows read backward to find an assistant message newer than the last model change. */
const MODEL_ROW_LIMIT = 1024;

type SuffixEntry = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  appendMode?: unknown;
  firstKeptEntryId?: unknown;
  message?: { role?: unknown };
  seq: number;
};

function isModelState(entry: SuffixEntry): boolean {
  return (
    entry.type === "model_change" ||
    (entry.type === "message" && entry.message?.role === "assistant")
  );
}

/**
 * Selects the part of a session's active path that context selection reads, without
 * the history before it. A session lives through many resets and compactions, and
 * its model context starts at the first entry its newest boundary keeps; scanning
 * every row back to the session's first day cost seconds on each run.
 *
 * `rows` are the active path from that entry on, exactly as a scan of the whole
 * session selects it, because every row continues the row before: no branch, leaf
 * control, side append or opaque row can change what its ancestors mean. With
 * `stateBefore`, `state` holds the newest model and thinking state set before the
 * rows for whichever of the two the rows carry none, as `findLast` over the whole
 * path would find them. Anything else returns undefined and the caller scans the
 * whole session.
 */
export function selectSessionContextSuffix<T extends SuffixEntry>(source: {
  /** Rows inside the caller's read bounds, newest first. */
  newestRows: (limit: number) => Iterable<T>;
  /** The newest wanted state on the active path below `seq`, oldest first; undefined when unsure. */
  stateBefore?: (seq: number, wanted: { model: boolean; thinking: boolean }) => T[] | undefined;
}): { state: T[]; rows: T[] } | undefined {
  const newestFirst: T[] = [];
  let boundary: T | undefined;
  let found = false;
  for (const entry of source.newestRows(SUFFIX_ROW_LIMIT)) {
    newestFirst.push(entry);
    if (!boundary) {
      if (entry.type !== "reset" && entry.type !== "compaction") {
        continue;
      }
      boundary = entry;
      // A boundary that keeps nothing, or names itself, starts the context.
      if (typeof entry.firstKeptEntryId !== "string" || entry.firstKeptEntryId === entry.id) {
        found = true;
        break;
      }
    } else if (entry.id === boundary.firstKeptEntryId) {
      found = true;
      break;
    }
  }
  if (!found) {
    return undefined;
  }
  const rows = newestFirst.toReversed();
  const ids = new Set<unknown>();
  for (const [index, entry] of rows.entries()) {
    const parentId = entry.parentId;
    if (
      !isCanonicalSessionTranscriptEntry(entry) ||
      entry.appendMode !== undefined ||
      typeof entry.id !== "string" ||
      !entry.id ||
      ids.has(entry.id) ||
      (index > 0
        ? parentId !== rows[index - 1]!.id
        : parentId !== undefined &&
          parentId !== null &&
          (typeof parentId !== "string" || !parentId))
    ) {
      return undefined;
    }
    ids.add(entry.id);
  }
  const wanted = {
    model: !rows.some(isModelState),
    thinking: !rows.some((entry) => entry.type === "thinking_level_change"),
  };
  if (!source.stateBefore || (!wanted.model && !wanted.thinking)) {
    return { state: [], rows };
  }
  const state = source.stateBefore(rows[0]!.seq, wanted);
  return state && { state, rows };
}

type NavigationRow = { seq: number; navigation_json: string };

export function* parseNavigationRows<T>(
  rows: Iterable<NavigationRow>,
): Generator<T & { seq: number }> {
  for (const row of rows) {
    // SAFETY: SQL preserves entry discriminants and replaces payloads with readable empty bodies.
    yield { ...(JSON.parse(row.navigation_json) as T), seq: row.seq };
  }
}

type StateDatabase = Pick<
  DB,
  "session_transcript_active_events" | "transcript_event_identities" | "transcript_events"
>;

/**
 * The newest model and thinking state on the active path below `seq`. A session's
 * later rows never change the ancestry of an entry already on its active path, so
 * the indexed path below that entry is the path a scan of the whole session selects.
 * Undefined when the index is behind, the entry is not on it, or some rows have no
 * typed identity to look state up by.
 */
function readActivePathStateBefore<T extends SuffixEntry>(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  seq: number,
  wanted: { model: boolean; thinking: boolean },
  parse: (rows: Iterable<NavigationRow>) => Iterable<T>,
): T[] | undefined {
  if (sessionTranscriptIndexNeedsReconcile(database.db, sessionId)) {
    return undefined;
  }
  const db = getNodeSqliteKysely<StateDatabase>(database.db);
  const first = <Row>(query: Parameters<typeof executeSqliteQueryTakeFirstSync<Row>>[1]) =>
    executeSqliteQueryTakeFirstSync(database.db, query);
  const active = db
    .selectFrom("session_transcript_active_events as active")
    .where("active.session_id", "=", sessionId);
  const identities = db
    .selectFrom("transcript_event_identities as identity")
    .where("identity.session_id", "=", sessionId);
  const firstEvent = first(
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc")
      .limit(1),
  );
  // Imported history can lack identities, or their types, for its oldest rows.
  if (
    !first(active.select("active.event_seq").where("active.event_seq", "=", seq)) ||
    !first(identities.select("identity.seq").where("identity.seq", "=", firstEvent?.seq ?? seq)) ||
    first(identities.select("identity.seq").where("identity.event_type", "is", null).limit(1))
  ) {
    return undefined;
  }
  const newest = (type: "model_change" | "thinking_level_change") =>
    first(
      identities
        .innerJoin("session_transcript_active_events as on_path", (join) =>
          join
            .onRef("on_path.session_id", "=", "identity.session_id")
            .onRef("on_path.event_seq", "=", "identity.seq"),
        )
        .select("identity.seq")
        .where("identity.event_type", "=", type)
        .where("identity.seq", "<", seq)
        .orderBy("identity.seq", "desc")
        .limit(1),
    )?.seq;
  const navigation = active
    .innerJoin("transcript_events", (join) =>
      join
        .onRef("transcript_events.session_id", "=", "active.session_id")
        .onRef("transcript_events.seq", "=", "active.event_seq"),
    )
    .select([
      "transcript_events.seq as seq",
      transcriptEventModelNavigationSql().as("navigation_json"),
    ]);
  const at = (stateSeq: number | undefined) =>
    stateSeq === undefined
      ? []
      : [
          ...parse(
            iterateSqliteQuerySync(
              database.db,
              navigation.where("active.event_seq", "=", stateSeq),
            ),
          ),
        ];
  const state = wanted.thinking ? at(newest("thinking_level_change")) : [];
  if (wanted.model) {
    // An assistant message newer than the last model change is the model state instead.
    const change = newest("model_change");
    let read = 0;
    let assistant: T | undefined;
    for (const entry of parse(
      iterateSqliteQuerySync(
        database.db,
        navigation
          .where("active.event_seq", "<", seq)
          .where("active.event_seq", ">", change ?? -1)
          .orderBy("active.event_seq", "desc")
          .limit(MODEL_ROW_LIMIT + 1),
      ),
    )) {
      read += 1;
      if (isModelState(entry)) {
        assistant = entry;
        break;
      }
    }
    if (!assistant && read > MODEL_ROW_LIMIT) {
      return undefined;
    }
    state.push(...(assistant ? [assistant] : at(change)));
  }
  return state.toSorted((left, right) => left.seq - right.seq);
}

/** Selects a session's context suffix inside the caller's read snapshot. */
export function readSessionContextSuffix<T extends SuffixEntry>(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  source: { state: boolean; newestRows: (limit: number) => Iterable<T> },
): { state: T[]; rows: T[] } | undefined {
  const suffix = selectSessionContextSuffix<T>({
    newestRows: source.newestRows,
    ...(source.state
      ? {
          stateBefore: (seq, wanted) =>
            readActivePathStateBefore(database, sessionId, seq, wanted, parseNavigationRows<T>),
        }
      : {}),
  });
  // Boundary normalization reads the ancestry of rows the entry codec rejects, so a
  // suffix holding one is left to the whole-session scan.
  return suffix?.rows.every((entry) => isIndexedSessionEntry(entry)) ? suffix : undefined;
}
