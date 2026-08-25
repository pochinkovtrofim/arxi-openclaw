import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Exa provider module implements model/runtime integration.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { readExaWebSearchConfig, resolveExaMaxSearchCount } from "./exa-web-search-config.js";
import { createExaWebSearchProviderBase } from "./exa-web-search-provider.shared.js";

const EXA_SEARCH_TYPES = ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"] as const;
const EXA_FRESHNESS_VALUES = ["day", "week", "month", "year"] as const;
const MAX_QUERY_CHARACTERS = 4096;
const MAX_CONTENT_QUERY_CHARACTERS = 4096;
const MAX_TEXT_CHARACTERS = 20_000;
const MAX_HIGHLIGHT_CHARACTERS = 4_000;
const MAX_HIGHLIGHT_SENTENCES = 10;
const MAX_HIGHLIGHTS_PER_URL = 10;

const loadExaWebSearchRuntime = createLazyRuntimeModule(
  () => import("./exa-web-search-provider.runtime.js"),
);

function createExaSearchSchema(maxSearchCount: number, strictLocalBroker: boolean) {
  return {
    type: "object",
    properties: {
      query: strictLocalBroker
        ? {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUERY_CHARACTERS,
            description: "Search query string.",
          }
        : { type: "string", description: "Search query string." },
      count: {
        type: "integer",
        description: `Number of results to return (1-${maxSearchCount}).`,
        minimum: 1,
        maximum: maxSearchCount,
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
          highlights: strictLocalBroker
            ? {
                anyOf: [
                  { type: "boolean" },
                  {
                    type: "object",
                    properties: {
                      maxCharacters: {
                        type: "integer",
                        minimum: 1,
                        maximum: MAX_HIGHLIGHT_CHARACTERS,
                      },
                      query: { type: "string", maxLength: MAX_CONTENT_QUERY_CHARACTERS },
                      numSentences: {
                        type: "integer",
                        minimum: 1,
                        maximum: MAX_HIGHLIGHT_SENTENCES,
                      },
                      highlightsPerUrl: {
                        type: "integer",
                        minimum: 1,
                        maximum: MAX_HIGHLIGHTS_PER_URL,
                      },
                    },
                    additionalProperties: false,
                  },
                ],
                description:
                  "Highlights config: true, or an object with maxCharacters, query, numSentences, or highlightsPerUrl.",
              }
            : {
                description:
                  "Highlights config: true, or an object with maxCharacters, query, numSentences, or highlightsPerUrl.",
              },
          text: strictLocalBroker
            ? {
                anyOf: [
                  { type: "boolean" },
                  {
                    type: "object",
                    properties: {
                      maxCharacters: {
                        type: "integer",
                        minimum: 1,
                        maximum: MAX_TEXT_CHARACTERS,
                      },
                    },
                    additionalProperties: false,
                  },
                ],
                description: "Text config: true, or an object with maxCharacters.",
              }
            : { description: "Text config: true, or an object with maxCharacters." },
          summary: strictLocalBroker
            ? {
                anyOf: [
                  { type: "boolean" },
                  {
                    type: "object",
                    properties: {
                      query: { type: "string", maxLength: MAX_CONTENT_QUERY_CHARACTERS },
                    },
                    additionalProperties: false,
                  },
                ],
                description: "Summary config: true, or an object with query.",
              }
            : { description: "Summary config: true, or an object with query." },
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
      const exaConfig = readExaWebSearchConfig(ctx.config as Record<string, unknown>);
      return {
        description:
          "Search the web using Exa AI. Supports neural or keyword search, publication date filters, and optional highlights or text extraction.",
        parameters: createExaSearchSchema(
          resolveExaMaxSearchCount(exaConfig),
          typeof exaConfig.localBaseUrl === "string" && exaConfig.localBaseUrl.trim() !== "",
        ),
        execute: async (args, context) => {
          context?.signal?.throwIfAborted();
          const { executeExaWebSearchProviderTool } = await loadExaWebSearchRuntime();
          return await executeExaWebSearchProviderTool(ctx, args, context?.signal);
        },
      };
    },
  };
}
