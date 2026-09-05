import { asPositiveSafeInteger as resolvePositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type {
  ModelCatalogProviderOutcome,
  ModelChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { projectWorkerPlacementAgentRuntime } from "../worker-environments/placement-session-runtime.js";

type ModelsListEntry = Pick<
  ModelChoice,
  | "alias"
  | "contextWindow"
  | "contextWindowDefault"
  | "contextWindows"
  | "id"
  | "input"
  | "name"
  | "provider"
  | "reasoning"
  | "tags"
> & { available?: boolean; supportsTools?: boolean };

type PublicModelInput = NonNullable<ModelChoice["input"]>[number];
const PUBLIC_MODEL_INPUTS = new Set<PublicModelInput>([
  "text",
  "image",
  "audio",
  "video",
  "document",
]);

function normalizePublicModelInputs(value: unknown): PublicModelInput[] | undefined {
  const inputs = normalizeUniqueTrimmedStringList(value).filter(
    (input): input is PublicModelInput => PUBLIC_MODEL_INPUTS.has(input as PublicModelInput),
  );
  return inputs.length > 0 ? inputs : undefined;
}

/** Keeps concrete route, auth, cost, and provider parameters out of public model rows. */
export function buildPublicModelProjection(
  entry: ModelCatalogEntry,
  options?: { includeInput?: boolean },
): ModelsListEntry {
  const contextWindow = resolvePositiveSafeInteger(entry.contextWindow);
  const input = options?.includeInput ? normalizePublicModelInputs(entry.input) : undefined;
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(entry.contextWindows ? { contextWindows: entry.contextWindows } : {}),
    ...(entry.contextWindowDefault ? { contextWindowDefault: entry.contextWindowDefault } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.compat?.supportsTools === "boolean"
      ? { supportsTools: entry.compat.supportsTools }
      : {}),
    ...(input ? { input } : {}),
  };
}

export function projectProviderCatalogOutcomes(
  outcomes: readonly ProviderCatalogOutcome[] | undefined,
): readonly ModelCatalogProviderOutcome[] | undefined {
  return outcomes?.map(({ provider, profileId, status }) => ({
    provider,
    ...(profileId ? { profileId } : {}),
    status,
  }));
}

export function resolveModelChoiceAgentRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: ModelCatalogEntry;
}): GatewayAgentRuntime | undefined {
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider: params.entry.provider,
    modelId: params.entry.id,
    modelApi: params.entry.api,
    modelBaseUrl: params.entry.baseUrl,
    config: params.cfg,
    agentId: params.agentId,
  });
  if (harnessPolicy.runtime === "auto") {
    return undefined;
  }
  return projectWorkerPlacementAgentRuntime({
    id: harnessPolicy.runtime,
    source: harnessPolicy.runtimeSource ?? "implicit",
  });
}
