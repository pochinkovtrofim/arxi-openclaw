import type { CronJob } from "../types.js";

export function resolveCronNativePurpose(
  job: Pick<CronJob, "schedule" | "deleteAfterRun">,
): "exact_reminder" | undefined {
  return job.schedule.kind === "at" && job.deleteAfterRun === true ? "exact_reminder" : undefined;
}
