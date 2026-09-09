import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { ensureTaskFlowAutomationObligationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type {
  TaskFlowAutomationObligation,
  TaskFlowAutomationObligationPhase,
  UpsertTaskFlowAutomationObligation,
} from "./task-flow-automation-obligation.types.js";

const PHASES = new Set<TaskFlowAutomationObligationPhase>([
  "bound",
  "scheduled",
  "suspended",
  "blocked",
]);
const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "lost"] as const;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TRIGGER_KIND_LENGTH = 256;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

type ObligationRow = Selectable<OpenClawStateKyselyDatabase["task_flow_automation_obligations"]>;
type FlowStateRow = Pick<
  Selectable<OpenClawStateKyselyDatabase["flow_runs"]>,
  "revision" | "controller_id" | "sync_mode" | "status" | "ended_at" | "cancel_requested_at"
>;

function requireText(value: unknown, label: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new Error(`Invalid Task Flow Automation obligation ${label}.`);
  return value;
}
function requireDigest(value: unknown): string {
  const digest = requireText(value, "trigger digest", 64);
  if (!DIGEST_PATTERN.test(digest))
    throw new Error("Invalid Task Flow Automation obligation trigger digest.");
  return digest;
}
function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" && typeof value !== "bigint" && value !== null) {
    throw new Error(`Invalid Task Flow Automation obligation ${label}.`);
  }
  const number = normalizeSqliteNumber(value);
  if (number === undefined || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`Invalid Task Flow Automation obligation ${label}.`);
  return number;
}
function parsePhase(value: unknown): TaskFlowAutomationObligationPhase {
  if (typeof value !== "string" || !PHASES.has(value as TaskFlowAutomationObligationPhase))
    throw new Error("Invalid Task Flow Automation obligation phase.");
  return value as TaskFlowAutomationObligationPhase;
}
function rowToObligation(row: ObligationRow): TaskFlowAutomationObligation {
  return {
    obligationId: requireText(row.obligation_id, "id"),
    flowId: requireText(row.flow_id, "flow id"),
    controllerId: requireText(row.controller_id, "controller id"),
    flowRevision: requireInteger(row.flow_revision, "flow revision"),
    cronStoreKey: requireText(row.cron_store_key, "cron store key"),
    cronJobId: requireText(row.cron_job_id, "cron job id"),
    cronScheduleIdentity: requireText(row.cron_schedule_identity, "cron schedule identity"),
    sourceRunId: requireText(row.source_run_id, "source run id"),
    triggerAtMs: requireInteger(row.trigger_at_ms, "trigger time"),
    scheduledAtMs: requireInteger(row.scheduled_at_ms, "scheduled time"),
    triggerKind: requireText(row.trigger_kind, "trigger kind", MAX_TRIGGER_KIND_LENGTH),
    triggerDigest: requireDigest(row.trigger_digest),
    phase: parsePhase(row.phase),
    createdAtMs: requireInteger(row.created_at_ms, "created time"),
    updatedAtMs: requireInteger(row.updated_at_ms, "updated time"),
  };
}
function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number]);
}
function loadFlow(db: DatabaseSync, flowId: string): FlowStateRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
      .selectFrom("flow_runs")
      .select([
        "revision",
        "controller_id",
        "sync_mode",
        "status",
        "ended_at",
        "cancel_requested_at",
      ])
      .where("flow_id", "=", flowId),
  );
}
function requireLiveManagedFlow(
  db: DatabaseSync,
  params: Pick<
    UpsertTaskFlowAutomationObligation,
    "flowId" | "expectedFlowRevision" | "controllerId"
  >,
): void {
  const flow = loadFlow(db, params.flowId);
  if (
    !flow ||
    normalizeSqliteNumber(flow.revision) !== params.expectedFlowRevision ||
    flow.controller_id !== params.controllerId ||
    flow.sync_mode !== "managed" ||
    flow.ended_at !== null ||
    flow.cancel_requested_at !== null ||
    isTerminal(flow.status)
  )
    throw new Error("Task Flow Automation obligation flow is not a live managed controller Flow.");
}

/** Must run inside the caller's existing state write transaction with its Flow CAS. */
export function upsertTaskFlowAutomationObligationInStateTransaction(
  db: DatabaseSync,
  params: UpsertTaskFlowAutomationObligation,
): TaskFlowAutomationObligation {
  ensureTaskFlowAutomationObligationSchema(db);
  requireLiveManagedFlow(db, params);
  const now = requireInteger(params.now ?? Date.now(), "clock");
  const row: Insertable<OpenClawStateKyselyDatabase["task_flow_automation_obligations"]> = {
    obligation_id: crypto.randomUUID(),
    flow_id: requireText(params.flowId, "flow id"),
    controller_id: requireText(params.controllerId, "controller id"),
    flow_revision: requireInteger(params.expectedFlowRevision, "flow revision"),
    cron_store_key: requireText(params.cronStoreKey, "cron store key"),
    cron_job_id: requireText(params.cronJobId, "cron job id"),
    cron_schedule_identity: requireText(params.cronScheduleIdentity, "cron schedule identity"),
    source_run_id: requireText(params.sourceRunId, "source run id"),
    trigger_at_ms: requireInteger(params.triggerAtMs, "trigger time"),
    scheduled_at_ms: requireInteger(params.scheduledAtMs, "scheduled time"),
    trigger_kind: requireText(params.triggerKind, "trigger kind", MAX_TRIGGER_KIND_LENGTH),
    trigger_digest: requireDigest(params.triggerDigest),
    phase: "bound",
    created_at_ms: now,
    updated_at_ms: now,
  };
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("task_flow_automation_obligations")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("flow_id").doUpdateSet({
          controller_id: (eb) => eb.ref("excluded.controller_id"),
          flow_revision: (eb) => eb.ref("excluded.flow_revision"),
          cron_store_key: (eb) => eb.ref("excluded.cron_store_key"),
          cron_job_id: (eb) => eb.ref("excluded.cron_job_id"),
          cron_schedule_identity: (eb) => eb.ref("excluded.cron_schedule_identity"),
          source_run_id: (eb) => eb.ref("excluded.source_run_id"),
          trigger_at_ms: (eb) => eb.ref("excluded.trigger_at_ms"),
          scheduled_at_ms: (eb) => eb.ref("excluded.scheduled_at_ms"),
          trigger_kind: (eb) => eb.ref("excluded.trigger_kind"),
          trigger_digest: (eb) => eb.ref("excluded.trigger_digest"),
          phase: "bound",
          updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
        }),
      ),
  );
  const saved = executeSqliteQueryTakeFirstSync<ObligationRow>(
    db,
    kysely
      .selectFrom("task_flow_automation_obligations")
      .selectAll()
      .where("flow_id", "=", row.flow_id),
  );
  if (!saved) throw new Error("Task Flow Automation obligation write was lost.");
  return rowToObligation(saved);
}

/** Removes an obligation only after the caller's Flow transition is durably terminal. */
export function removeTaskFlowAutomationObligationForTerminalFlowInStateTransaction(
  db: DatabaseSync,
  params: { flowId: string; expectedFlowRevision: number; controllerId: string },
): boolean {
  if (!tableExists(db, "task_flow_automation_obligations")) return false;
  const flow = loadFlow(db, params.flowId);
  if (!flow) return false;
  if (
    normalizeSqliteNumber(flow.revision) !== params.expectedFlowRevision ||
    flow.controller_id !== params.controllerId ||
    flow.sync_mode !== "managed"
  )
    throw new Error("Task Flow Automation obligation terminal flow ownership changed.");
  if (flow.ended_at === null && !isTerminal(flow.status))
    throw new Error("Task Flow Automation obligation terminal removal requires a terminal flow.");
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
      .deleteFrom("task_flow_automation_obligations")
      .where("flow_id", "=", params.flowId),
  );
  return (result.numAffectedRows ?? 0n) > 0n;
}

/** Advances one receipt only from the expected durable phase and revision. */
export function transitionTaskFlowAutomationObligationPhaseInStateTransaction(
  db: DatabaseSync,
  params: {
    flowId: string;
    expectedFlowRevision: number;
    from: TaskFlowAutomationObligationPhase;
    to: TaskFlowAutomationObligationPhase;
    now?: number;
  },
): boolean {
  ensureTaskFlowAutomationObligationSchema(db);
  parsePhase(params.from);
  parsePhase(params.to);
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
      .updateTable("task_flow_automation_obligations")
      .set({ phase: params.to, updated_at_ms: requireInteger(params.now ?? Date.now(), "clock") })
      .where("flow_id", "=", params.flowId)
      .where("flow_revision", "=", params.expectedFlowRevision)
      .where("phase", "=", params.from),
  );
  return (result.numAffectedRows ?? 0n) > 0n;
}

/** Lists only live receipts for the exact scheduler store and existing job. */
export function listTaskFlowAutomationObligationsForCronJobFromSqlite(
  db: DatabaseSync,
  params: {
    cronStoreKey: string;
    cronJobId: string;
    phases?: readonly TaskFlowAutomationObligationPhase[];
  },
): TaskFlowAutomationObligation[] {
  ensureTaskFlowAutomationObligationSchema(db);
  const phases = params.phases ?? ["bound", "scheduled", "suspended", "blocked"];
  for (const phase of phases) parsePhase(phase);
  if (phases.length === 0) return [];
  const rows = executeSqliteQuerySync<ObligationRow>(
    db,
    getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
      .selectFrom("task_flow_automation_obligations as obligation")
      .innerJoin("flow_runs as flow", (join) =>
        join
          .onRef("flow.flow_id", "=", "obligation.flow_id")
          .on("flow.sync_mode", "=", "managed")
          // A nonterminal Flow can change outside its paced Automation run.
          // Its existing receipt remains one bounded opportunity until it is
          // atomically replaced, consumed, or terminally removed.
          .onRef("flow.controller_id", "=", "obligation.controller_id"),
      )
      .selectAll("obligation")
      .where("obligation.cron_store_key", "=", requireText(params.cronStoreKey, "cron store key"))
      .where("obligation.cron_job_id", "=", requireText(params.cronJobId, "cron job id"))
      .where("obligation.phase", "in", phases)
      .where("flow.ended_at", "is", null)
      .where("flow.cancel_requested_at", "is", null)
      .where("flow.status", "not in", TERMINAL_STATUSES)
      .orderBy("obligation.scheduled_at_ms", "asc")
      .orderBy("obligation.flow_id", "asc"),
  ).rows;
  return rows.map(rowToObligation);
}
export function findEarliestTaskFlowAutomationObligationForCronJobFromSqlite(
  db: DatabaseSync,
  params: { cronStoreKey: string; cronJobId: string },
): TaskFlowAutomationObligation | undefined {
  return listTaskFlowAutomationObligationsForCronJobFromSqlite(db, {
    ...params,
    phases: ["bound"],
  })[0];
}
