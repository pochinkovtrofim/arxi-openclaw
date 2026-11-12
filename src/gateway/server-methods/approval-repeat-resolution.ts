import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import type { RespondFn } from "./types.js";

const APPROVAL_ALREADY_RESOLVED_DETAILS = {
  reason: "APPROVAL_ALREADY_RESOLVED",
} as const;

/** Answers a retried resolution from the first durable operator decision. */
export function respondRepeatedApprovalResolution<TPayload>(
  record: ExecApprovalRecord<TPayload>,
  decision: ExecApprovalDecision,
  respond: RespondFn,
): void {
  // Identical retries are idempotent; a conflicting retry must never replace
  // or obscure the first durable operator decision.
  if ((record.decision ?? record.consumedDecision) === decision) {
    respond(true, { ok: true }, undefined);
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "approval already resolved", {
      details: APPROVAL_ALREADY_RESOLVED_DETAILS,
    }),
  );
}
