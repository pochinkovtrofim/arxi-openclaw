/** Optional dynamic-cadence bounds for one cron job. */
export type CronPacing = {
  min?: string;
  max?: string;
};

/**
 * Host wake policy for a suspended gateway. "never" keeps a due run out of the
 * suspend wake deadline; the job still runs once at the first scheduler pass
 * after any other wake. Omitted means "always".
 */
type CronSuspendWake = "always" | "never";

/** Shared persisted cron job envelope used by runtime and external config shapes. */
export type CronJobBase<TSchedule, TSessionTarget, TWakeMode, TPayload, TDelivery, TFailureAlert> =
  {
    id: string;
    agentId?: string;
    sessionKey?: string;
    name: string;
    description?: string;
    enabled: boolean;
    deleteAfterRun?: boolean;
    createdAtMs: number;
    updatedAtMs: number;
    schedule: TSchedule;
    pacing?: CronPacing;
    sessionTarget: TSessionTarget;
    wakeMode: TWakeMode;
    suspendWake?: CronSuspendWake;
    payload: TPayload;
    delivery?: TDelivery;
    failureAlert?: TFailureAlert;
  };
