import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  hasSessionPendingInputsSchema,
  hasPendingInputConsumptionColumn,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  parseSessionPendingInputMessage,
  readSessionPendingInputByKey,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readMessageIdempotencyKey,
  readTranscriptMessageByScopedIdempotencyKey,
} from "./session-accessor.sqlite-transcript-store.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";

type PendingInputScope = SessionAccessScope & { agentId: string; sessionId: string };

/** Read one admitted source for explicit retry comparison; this never authorizes replay. */
export function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): PersistedUserTurnMessage | undefined {
  try {
    const resolved = resolveSqliteTranscriptScope(scope);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(database.db, () => {
          const db = getSessionKysely(database.db);
          const session = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("session_nodes")
              .innerJoin(
                "session_windows",
                "session_windows.session_id",
                "session_nodes.current_session_id",
              )
              .select("current_session_id")
              .where("session_nodes.session_key", "=", resolved.sessionKey)
              .where("session_windows.session_key", "=", resolved.sessionKey),
          );
          if (session?.current_session_id !== resolved.sessionId) {
            return undefined;
          }
          // Collected sources survive consumption; their text is not the aggregate transcript.
          // Check byte metadata before either reader materializes stored JSON.
          const pending = hasSessionPendingInputsSchema(database.db)
            ? executeSqliteQueryTakeFirstSync(
                database.db,
                db
                  .selectFrom("session_pending_inputs")
                  .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes"))
                  .where("session_key", "=", resolved.sessionKey)
                  .where("session_id", "=", resolved.sessionId)
                  .where("idempotency_key", "=", idempotencyKey),
              )
            : undefined;
          let messageJson: string | undefined;
          if (pending) {
            if (pending.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            messageJson = readSessionPendingInputByKey(
              database,
              resolved,
              idempotencyKey,
            )?.message_json;
          } else {
            // Stale projections cannot establish retry identity. Their owning writer repairs them.
            if (sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId)) {
              return undefined;
            }
            const transcript = executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("transcript_event_identities as identity")
                .innerJoin("transcript_events as event", (join) =>
                  join
                    .onRef("event.session_id", "=", "identity.session_id")
                    .onRef("event.seq", "=", "identity.seq"),
                )
                .select((eb) => eb.fn<number>("octet_length", ["event.event_json"]).as("bytes"))
                .where("identity.session_id", "=", resolved.sessionId)
                .where("identity.message_idempotency_key", "=", idempotencyKey)
                .orderBy("identity.seq", "desc")
                .limit(1),
            );
            if (!transcript || transcript.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            const committed = readTranscriptMessageByScopedIdempotencyKey(
              database,
              resolved,
              idempotencyKey,
              "scan",
            );
            messageJson = committed ? JSON.stringify(committed.message) : undefined;
          }
          if (!messageJson) {
            return undefined;
          }
          const message = parseSessionPendingInputMessage(messageJson);
          return readMessageIdempotencyKey(message) === idempotencyKey ? message : undefined;
        }),
      toDatabaseOptions(resolved),
    );
    return result.found ? result.value : undefined;
  } catch {
    // Unavailable or corrupt storage supplies no proof of the original submitted bytes.
    return undefined;
  }
}

/** Bounded display reconciliation; these durable correlations never authorize replay. */
export function listSessionPendingInputReceipts(
  scope: PendingInputScope,
  options: { runIds: readonly string[] },
): Array<
  | { runId: string; state: "pending" }
  | { runId: string; state: "consumed"; consumedByEventId: string }
> {
  if (options.runIds.length > 50) {
    throw new Error("Pending input receipt lookup accepts at most 50 run IDs");
  }
  const runIds = [...new Set(options.runIds)];
  if (!runIds.length) {
    return [];
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (
      !hasSessionPendingInputsSchema(database.db) ||
      !hasPendingInputConsumptionColumn(database.db)
    ) {
      return [];
    }
    const rows = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_pending_inputs")
        .select(["run_id", "consumed_event_id"])
        .where("session_key", "=", resolved.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("run_id", "in", runIds)
        .orderBy("seq", "asc")
        .limit(51),
    ).rows;
    // A run ID is correlation, not unique authority. Never retire an ambiguous
    // provisional message when another source with that run is still pending.
    if (rows.length > 50 || new Set(rows.map((row) => row.run_id)).size !== rows.length) {
      throw new Error("Pending input receipt lookup has ambiguous source run IDs");
    }
    return rows.map((row) =>
      row.consumed_event_id == null
        ? { runId: row.run_id, state: "pending" as const }
        : {
            runId: row.run_id,
            state: "consumed" as const,
            consumedByEventId: row.consumed_event_id,
          },
    );
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}
