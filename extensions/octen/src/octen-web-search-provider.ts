import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";

const credentialPath = "plugins.entries.octen.config.webSearch.apiKey";
const loadRuntime = createLazyRuntimeModule(() => import("./octen-web-search-provider.runtime.js"));

export function createOctenWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "octen",
    label: "Octen Search",
    hint: "Web search with publication date filters and highlighted passages",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Octen API key",
    envVars: ["OCTEN_API_KEY"],
    placeholder: "octen-...",
    signupUrl: "https://octen.ai/",
    docsUrl: "https://docs.octen.ai/api-reference/search",
    autoDetectOrder: 65,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: "octen" },
      configuredCredential: { pluginId: "octen" },
      selectionPluginId: "octen",
    }),
    createTool: (ctx) => ({
      description:
        "Search the web with Octen. Results include source URLs, highlighted passages, and publication dates when available.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query, up to 500 characters." },
          count: { type: "integer", minimum: 1, maximum: 100 },
          freshness: { type: "string", enum: ["day", "week", "month", "year"] },
          date_after: { type: "string", description: "Published on or after YYYY-MM-DD." },
          date_before: { type: "string", description: "Published on or before YYYY-MM-DD." },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        const { executeOctenWebSearchProviderTool } = await loadRuntime();
        return executeOctenWebSearchProviderTool(ctx, args, context?.signal);
      },
    }),
  };
}
