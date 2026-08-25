import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Exa provider module implements model/runtime integration.
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import {
  ARXI_EXA_SEARCH_ENDPOINT,
  createExaWebSearchProviderBase,
} from "./exa-web-search-provider.shared.js";

const EXA_SEARCH_TYPES = ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"] as const;
const EXA_FRESHNESS_VALUES = ["day", "week", "month", "year"] as const;
const EXA_MAX_SEARCH_COUNT = 100;
const ARXI_MAX_SEARCH_COUNT = 10;

const loadExaWebSearchRuntime = createLazyRuntimeModule(
  () => import("./exa-web-search-provider.runtime.js"),
);

function exaSearchSchema(maximum: number) {
  return {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query string." },
      count: {
        type: "integer",
        description: `Number of results to return (1-${maximum}, subject to Exa search-type limits).`,
        minimum: 1,
        maximum,
      },
      freshness: {
        type: "string",
        enum: [...EXA_FRESHNESS_VALUES],
        description: 'Filter by time: "day", "week", "month", or "year".',
      },
      date_after: {
        type: "string",
        description: "Only results published after this date (YYYY-MM-DD).",
      },
      date_before: {
        type: "string",
        description: "Only results published before this date (YYYY-MM-DD).",
      },
      type: {
        type: "string",
        enum: [...EXA_SEARCH_TYPES],
        description:
          'Exa search mode: "auto", "neural", "fast", "deep", "deep-reasoning", or "instant".',
      },
      contents: {
        type: "object",
        properties: {
          highlights: {
            description:
              "Highlights config: true, or an object with maxCharacters, query, numSentences, or highlightsPerUrl.",
          },
          text: {
            description: "Text config: true, or an object with maxCharacters.",
          },
          summary: {
            description: "Summary config: true, or an object with query.",
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  } satisfies Record<string, unknown>;
}

export function createExaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createExaWebSearchProviderBase(),
    createTool: (ctx) => {
      const pluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "exa");
      const baseUrl = typeof pluginConfig?.baseUrl === "string" ? pluginConfig.baseUrl : "";
      const localEndpoint = `${baseUrl.trim().replace(/\/+$/, "")}/search`;
      const maxCount =
        localEndpoint === ARXI_EXA_SEARCH_ENDPOINT ? ARXI_MAX_SEARCH_COUNT : EXA_MAX_SEARCH_COUNT;
      return {
        description:
          "Search the web using Exa AI. Supports neural or keyword search, publication date filters, and optional highlights or text extraction.",
        parameters: exaSearchSchema(maxCount),
        execute: async (args, context) => {
          context?.signal?.throwIfAborted();
          const { executeExaWebSearchProviderTool } = await loadExaWebSearchRuntime();
          return await executeExaWebSearchProviderTool(ctx, args, context?.signal);
        },
      };
    },
  };
}
