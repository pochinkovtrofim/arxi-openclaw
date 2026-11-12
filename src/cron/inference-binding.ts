import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProviderModelRouteAuthRequirement } from "../plugin-sdk/provider-model-types.js";

/** Scheduler-owned identity, not a user model pin or a copy of credential material. */
export type CronInferenceBinding = {
  version: 1;
  provider: string;
  profileId: string;
  authorizationId: string;
  authRequirement: ProviderModelRouteAuthRequirement;
  source: "auto" | "user";
};

/**
 * Ro's host owns every model login in an Owner's VM (`ARXI_AUTH_AGENT_DIR`) and replaces it
 * whenever the Owner reconnects or changes their model. One Owner owns every job there, so a
 * job follows the Owner's current account as their chat does: it records no account, needs
 * none to run, and a recorded one is not consulted. Without this every job that existed
 * before the account check stopped at "no recorded inference account" (2026-11-12): Doctor
 * repairs with the Gateway's logins withheld, so it could adopt none.
 */
export function cronJobsFollowOwnerAccount(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ARXI_AUTH_AGENT_DIR?.trim());
}

/** The account a run is held to; none where jobs follow the Owner's current account. */
export function resolveCronRunInferenceBinding(
  job: { inferenceBinding?: CronInferenceBinding } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CronInferenceBinding | undefined {
  return cronJobsFollowOwnerAccount(env) ? undefined : job?.inferenceBinding;
}

/** The recorded account as a run's auth selection, when the run is held to one. */
export function resolveCronRunBoundSelection(
  job: { inferenceBinding?: CronInferenceBinding } | undefined,
): Pick<CronInferenceBinding, "profileId" | "source"> | undefined {
  const binding = resolveCronRunInferenceBinding(job);
  return binding ? { profileId: binding.profileId, source: binding.source } : undefined;
}

/** Stored bindings are private scheduler state, never accepted from public job input. */
export function normalizeCronInferenceBinding(value: unknown): CronInferenceBinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Invalid automation inference binding.");
  }
  const binding = value;
  if (
    binding.version !== 1 ||
    typeof binding.provider !== "string" ||
    !binding.provider.trim() ||
    typeof binding.profileId !== "string" ||
    !binding.profileId.trim() ||
    typeof binding.authorizationId !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.authorizationId) ||
    (binding.authRequirement !== "api-key" && binding.authRequirement !== "subscription") ||
    (binding.source !== "auto" && binding.source !== "user")
  ) {
    throw new Error("Invalid automation inference binding; explicitly select an account again.");
  }
  return {
    version: 1,
    provider: binding.provider,
    profileId: binding.profileId,
    authorizationId: binding.authorizationId,
    authRequirement: binding.authRequirement,
    source: binding.source,
  };
}
