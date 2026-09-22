import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import type { CronJob } from "../types.js";

export function resolveCronNativePurpose(
  job: Pick<CronJob, "schedule" | "deleteAfterRun">,
): "exact_reminder" | undefined {
  return job.schedule.kind === "at" && job.deleteAfterRun === true ? "exact_reminder" : undefined;
}

export function resolveCronSuppression(params: { reason: string; uncertain: boolean }): {
  status: "unknown" | "not-delivered";
  error?: string;
  reason?: NormalizeReplySkipReason;
} {
  const reason = params.uncertain ? "adapter_returned_no_identity" : params.reason;
  if (params.uncertain) {
    return { status: "unknown", error: `cron delivery outcome is unknown: ${reason}` };
  }
  return reason === "adapter_returned_no_send"
    ? { status: "not-delivered", reason }
    : { status: "not-delivered", error: `cron delivery was suppressed: ${reason}` };
}
