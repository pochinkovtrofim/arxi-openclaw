import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  parseIsoDateRange,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  type SearchConfigRecord,
  withArxiOctenWebSearchEndpoint,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const API_URL = "https://api.octen.ai/search";
const HOST_URL = "http://127.0.0.1:18080/octen/search";
const DOCS_URL = "https://docs.octen.ai/api-reference/search";
const MAX_COUNT = 100;
const MAX_QUERY_LENGTH = 500;

type OctenConfig = { apiKey?: string; baseUrl?: string };
type OctenResult = {
  title?: unknown;
  url?: unknown;
  highlight?: unknown;
  time_published?: unknown;
};
type OctenResponse = {
  code?: unknown;
  data?: { results?: unknown };
};

function resolveConfig(searchConfig?: SearchConfigRecord): OctenConfig {
  const configured = searchConfig?.octen;
  return configured && typeof configured === "object" && !Array.isArray(configured)
    ? (configured as OctenConfig)
    : {};
}

function resolveEndpoint(config: OctenConfig): string | undefined {
  const configured = normalizeOptionalString(config.baseUrl);
  if (!configured) {
    return API_URL;
  }
  try {
    const url = new URL(configured);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash) {
      return undefined;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function usableResults(payload: OctenResponse): OctenResult[] {
  if (payload.code !== 0 || !Array.isArray(payload.data?.results)) {
    throw new Error("Octen rejected the search or returned an invalid result");
  }
  return payload.data.results.filter((entry): entry is OctenResult =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

export async function executeOctenWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "octen",
    resolveProviderWebSearchPluginConfig(ctx.config, "octen"),
  ) as SearchConfigRecord | undefined;
  const config = resolveConfig(searchConfig);
  const apiKey =
    readConfiguredSecretString(config.apiKey, "plugins.entries.octen.config.webSearch.apiKey") ??
    readProviderEnvValue(["OCTEN_API_KEY"]);
  if (!apiKey) {
    return {
      error: "missing_octen_api_key",
      message: "web_search (octen) needs an Octen API key.",
      docs: DOCS_URL,
    };
  }
  const endpoint = resolveEndpoint(config);
  if (!endpoint) {
    return {
      error: "invalid_base_url",
      message: "Octen baseUrl must be an HTTP(S) URL without query or fragment.",
      docs: DOCS_URL,
    };
  }
  const query = readStringParam(args, "query", { required: true });
  if (query.length > MAX_QUERY_LENGTH) {
    return {
      error: "invalid_query",
      message: "Octen query must be at most 500 characters.",
      docs: DOCS_URL,
    };
  }
  const count =
    readPositiveIntegerParam(args, "count", {
      max: MAX_COUNT,
      message: "count must be an integer from 1 to 100.",
    }) ??
    searchConfig?.maxResults ??
    DEFAULT_SEARCH_COUNT;
  const freshness = readStringParam(args, "freshness");
  if (freshness && !["day", "week", "month", "year"].includes(freshness)) {
    return {
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
      docs: DOCS_URL,
    };
  }
  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  if (freshness && (rawDateAfter || rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message: "Use freshness or date filters, not both.",
      docs: DOCS_URL,
    };
  }
  const dates = parseIsoDateRange({
    rawDateAfter,
    rawDateBefore,
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD.",
    invalidDateRangeMessage: "date_after must not be later than date_before.",
    docs: DOCS_URL,
  });
  if ("error" in dates) {
    return dates;
  }
  const body: Record<string, unknown> = { query, count };
  if (freshness || dates.dateAfter || dates.dateBefore) {
    body.time_basis = "published";
    if (freshness) {
      body.time_range = freshness;
    }
    if (dates.dateAfter) {
      body.start_time = `${dates.dateAfter}T00:00:00Z`;
    }
    if (dates.dateBefore) {
      body.end_time = `${dates.dateBefore}T23:59:59Z`;
    }
  }
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cacheKey = buildSearchCacheKey([
    "octen",
    endpoint,
    query,
    count,
    freshness,
    dates.dateAfter,
    dates.dateBefore,
  ]);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }
  const start = Date.now();
  const withEndpoint =
    endpoint === HOST_URL ? withArxiOctenWebSearchEndpoint : withTrustedWebSearchEndpoint;
  const results = await withEndpoint(
    {
      url: endpoint,
      timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      signal,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      },
    },
    async (response) => {
      if (!response.ok) {
        throw new Error(`Octen API error (${response.status})`);
      }
      return usableResults(
        await readProviderJsonResponse<OctenResponse>(response, "Octen API", {
          maxBytes: 16 * 1024 * 1024,
        }),
      );
    },
  );
  signal?.throwIfAborted();
  const payload = {
    query,
    provider: "octen",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: { untrusted: true, source: "web_search", provider: "octen", wrapped: true },
    results: results.map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      const highlight = typeof entry.highlight === "string" ? entry.highlight : "";
      return {
        title: title ? wrapWebContent(title, "web_search") : "",
        url,
        description: highlight ? wrapWebContent(highlight, "web_search") : "",
        published: typeof entry.time_published === "string" ? entry.time_published : undefined,
        siteName: resolveSiteName(url) || undefined,
      };
    }),
  };
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
