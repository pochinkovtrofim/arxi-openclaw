import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeToolPolicyName } from "../agents/tool-policy-shared.js";
import type { CronAuthenticatedChannelRequester } from "../gateway/cron-creator-authority-grant.types.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import {
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledMcpToolBindings,
  resolveCronScheduledToolPolicy,
} from "./scheduled-tool-policy.js";
import type { CronStoredJob, CronToolsAllowProvenance } from "./types.js";

/** Authority facts must be authored data, never inherited fields or accessor results. */
function snapshotProvenanceRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.enumerable) {
      snapshot[key] = "value" in descriptor ? descriptor.value : undefined;
    }
  }
  return snapshot;
}

export function normalizeCronAuthenticatedChannelRequester(
  value: unknown,
): CronAuthenticatedChannelRequester | undefined {
  const input = snapshotProvenanceRecord(value);
  if (input?.version !== 1) {
    return undefined;
  }
  const channel = normalizeOptionalLowercaseString(input.channel);
  const accountId = normalizeOptionalAccountId(
    typeof input.accountId === "string" ? input.accountId : undefined,
  );
  const senderId = normalizeOptionalString(input.senderId);
  return channel && accountId && senderId
    ? { version: 1, channel, accountId, senderId }
    : undefined;
}

export function normalizeCronToolsAllowProvenance(
  value: unknown,
): CronToolsAllowProvenance | undefined {
  const input = snapshotProvenanceRecord(value);
  if (input?.version !== 1) {
    return undefined;
  }
  const channelRequester = normalizeCronAuthenticatedChannelRequester(input.channelRequester);
  const normalizedCallerOrigin = normalizeCronScheduledToolCallerOrigin(
    snapshotProvenanceRecord(input.callerOrigin),
  );
  const callerOrigin =
    normalizedCallerOrigin.kind === "unknown" ? undefined : normalizedCallerOrigin;
  if (input.source === "authenticated-requester") {
    if (callerOrigin) {
      return {
        version: 1,
        source: "authenticated-requester",
        callerOrigin,
        ...(channelRequester ? { channelRequester } : {}),
      };
    }
    return channelRequester
      ? { version: 1, source: "authenticated-requester", channelRequester }
      : undefined;
  }
  if (input.source !== "final-executable-surface") {
    return undefined;
  }
  const mcpToolBindings = normalizeCronScheduledMcpToolBindings(input.mcpToolBindings);
  return {
    version: 1,
    source: "final-executable-surface",
    ...(mcpToolBindings ? { mcpToolBindings } : {}),
    callerOrigin: normalizedCallerOrigin,
    ...(channelRequester ? { channelRequester } : {}),
  };
}

/** Caller origin is usable only within the job's persisted account policy. */
export function resolveCronAuthenticatedCallerOrigin(
  job: Pick<CronStoredJob, "payload" | "owner" | "scheduledToolPolicy" | "toolsAllowProvenance">,
) {
  const policy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    owner: job.owner,
    scheduledToolPolicy: job.scheduledToolPolicy,
  });
  if (policy?.mode !== "account") {
    return undefined;
  }
  const callerOrigin = normalizeCronToolsAllowProvenance(job.toolsAllowProvenance)?.callerOrigin;
  return callerOrigin?.kind === "unknown" ? undefined : callerOrigin;
}

/** Requester facts are usable only within the existing job owner and account policy. */
export function resolveCronAuthenticatedChannelRequester(
  job: Pick<CronStoredJob, "payload" | "owner" | "scheduledToolPolicy" | "toolsAllowProvenance">,
): CronAuthenticatedChannelRequester | undefined {
  const policy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    owner: job.owner,
    scheduledToolPolicy: job.scheduledToolPolicy,
  });
  if (policy?.mode !== "account") {
    return undefined;
  }
  const requester = normalizeCronToolsAllowProvenance(job.toolsAllowProvenance)?.channelRequester;
  return requester?.accountId === policy.ownerAccountId ? requester : undefined;
}

/**
 * A failure repair lends its owner conversation's tools to the job: the job keeps its own
 * requester facts, and only names without a binding take the turn's MCP identities.
 */
export function resolveCronRepairToolsAllowProvenance(params: {
  job: Pick<CronStoredJob, "toolsAllowProvenance">;
  toolsAllow: readonly string[] | null | undefined;
  lentMcpToolBindings: unknown;
}): CronToolsAllowProvenance | undefined {
  const existing = normalizeCronToolsAllowProvenance(params.job.toolsAllowProvenance);
  const kept =
    existing?.source === "final-executable-surface" ? (existing.mcpToolBindings ?? []) : [];
  const bound = new Set(kept.map((binding) => binding.name));
  const next = new Set((params.toolsAllow ?? []).map(normalizeToolPolicyName));
  const lent = (normalizeCronScheduledMcpToolBindings(params.lentMcpToolBindings) ?? []).filter(
    (binding) => next.has(binding.name) && !bound.has(binding.name),
  );
  if (existing?.source !== "final-executable-surface" && lent.length === 0) {
    return existing;
  }
  const mcpToolBindings = [...kept, ...lent];
  return {
    version: 1,
    source: "final-executable-surface",
    callerOrigin: existing?.callerOrigin ?? { kind: "unknown" },
    ...(existing?.channelRequester ? { channelRequester: existing.channelRequester } : {}),
    ...(mcpToolBindings.length > 0 ? { mcpToolBindings } : {}),
  };
}
