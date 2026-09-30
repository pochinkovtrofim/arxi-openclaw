import type {
  ModelDefinitionConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { OPENAI_GPT_61_SOL_MODEL_ID, OPENAI_GPT_55_PRO_MODEL_ID } from "./model-route-contract.js";
import { buildOpenAISyntheticCatalogEntry, findCatalogTemplate } from "./shared.js";

type CatalogEntries = Parameters<NonNullable<ProviderPlugin["augmentModelCatalog"]>>[0]["entries"];
type RuntimeCatalogTemplate = NonNullable<ReturnType<typeof findCatalogTemplate>> &
  Partial<Pick<ModelDefinitionConfig, "contextWindow">>;

export function buildOpenAIModernCatalogEntries(
  entries: CatalogEntries,
  policy: {
    gpt55ProTemplateIds: readonly string[];
    gpt55ProContextWindow: number;
    runtimeContextTokens: number;
  },
) {
  const gpt61SolTemplate = findCatalogTemplate({
    entries,
    providerId: "openai",
    templateIds: [OPENAI_GPT_61_SOL_MODEL_ID],
    // SAFETY: This retains the catalog entry type and reads only its optional contextWindow field.
  }) as RuntimeCatalogTemplate | undefined;
  const gpt55ProTemplate = findCatalogTemplate({
    entries,
    providerId: "openai",
    templateIds: policy.gpt55ProTemplateIds,
  });
  return [
    buildOpenAISyntheticCatalogEntry(gpt61SolTemplate, {
      id: OPENAI_GPT_61_SOL_MODEL_ID,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: gpt61SolTemplate?.contextWindow ?? 1_050_000,
    }),
    buildOpenAISyntheticCatalogEntry(gpt55ProTemplate, {
      id: OPENAI_GPT_55_PRO_MODEL_ID,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: policy.gpt55ProContextWindow,
      contextTokens: policy.runtimeContextTokens,
    }),
  ];
}
