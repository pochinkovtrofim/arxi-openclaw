export const TASK_FLOW_AUTOMATION_OBLIGATION_PHASES = [
  "bound",
  "scheduled",
  "suspended",
  "blocked",
] as const;

export type TaskFlowAutomationObligationPhase =
  (typeof TASK_FLOW_AUTOMATION_OBLIGATION_PHASES)[number];

export type TaskFlowAutomationObligation = {
  obligationId: string;
  flowId: string;
  controllerId: string;
  flowRevision: number;
  cronStoreKey: string;
  cronJobId: string;
  cronScheduleIdentity: string;
  sourceRunId: string;
  triggerAtMs: number;
  /** The one native pacing result; recovery reuses it and never renews pacing. */
  scheduledAtMs: number;
  triggerKind: string;
  triggerDigest: string;
  phase: TaskFlowAutomationObligationPhase;
  createdAtMs: number;
  updatedAtMs: number;
};

export type UpsertTaskFlowAutomationObligation = Omit<
  TaskFlowAutomationObligation,
  "obligationId" | "flowRevision" | "phase" | "createdAtMs" | "updatedAtMs"
> & {
  expectedFlowRevision: number;
  now?: number;
};
