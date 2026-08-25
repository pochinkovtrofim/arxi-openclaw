// Exa provider module implements model/runtime integration.
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
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
  withLoopbackWebSearchEndpoint,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { type ExaWebSearchConfig, resolveExaMaxSearchCount } from "./exa-web-search-config.js";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const EXA_SEARCH_TYPES = ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"] as const;
const EXA_FRESHNESS_VALUES = ["day", "week", "month", "year"] as const;
const MAX_QUERY_CHARACTERS = 4096;
const MAX_CONTENT_QUERY_CHARACTERS = 4096;
const MAX_TEXT_CHARACTERS = 20_000;
const MAX_HIGHLIGHT_CHARACTERS = 4_000;
const MAX_HIGHLIGHT_SENTENCES = 10;
const MAX_HIGHLIGHTS_PER_URL = 10;
const EXA_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
// Exa search responses are untrusted external bodies. Cap the success JSON the
// same way other bundled providers do (16 MiB) so a misbehaving or hostile
// endpoint cannot stream an unbounded body into memory before we parse it.
const EXA_SEARCH_JSON_MAX_BYTES = 16 * 1024 * 1024;

type ExaConfig = ExaWebSearchConfig;
type ExaEndpointMode = "loopback" | "strict";

type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];
type ExaFreshness = (typeof EXA_FRESHNESS_VALUES)[number];

type ExaTextContentsOption = boolean | { maxCharacters?: number };
type ExaHighlightsContentsOption =
  | boolean
  | {
      maxCharacters?: number;
      query?: string;
      numSentences?: number;
      highlightsPerUrl?: number;
    };
type ExaSummaryContentsOption = boolean | { query?: string };

type ExaContentsArgs = {
  highlights?: ExaHighlightsContentsOption;
  text?: ExaTextContentsOption;
  summary?: ExaSummaryContentsOption;
};

type ExaSearchResult = {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
  highlightScores?: unknown;
  summary?: unknown;
  text?: unknown;
};

type ExaSearchResponse = {
  results?: unknown;
};

async function readExaSearchResults(
  response: Response,
  opts?: { maxBytes?: number },
): Promise<ExaSearchResult[]> {
  const maxBytes = opts?.maxBytes ?? EXA_SEARCH_JSON_MAX_BYTES;
  const bytes = await readResponseWithLimit(response, maxBytes, {
    onOverflow: ({ maxBytes: maxBytesLocal }) =>
      new Error(`Exa API response exceeds ${maxBytesLocal} bytes`),
  });
  try {
    return normalizeExaResults(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (cause) {
    throw new Error("Exa API returned malformed JSON", { cause });
  }
}

async function readExaErrorDetail(response: Response): Promise<string> {
  return await readResponseTextLimited(response, EXA_ERROR_BODY_LIMIT_BYTES);
}

function normalizeExaFreshness(value: string | undefined): ExaFreshness | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  if (!trimmed) {
    return undefined;
  }
  return EXA_FRESHNESS_VALUES.includes(trimmed as ExaFreshness)
    ? (trimmed as ExaFreshness)
    : undefined;
}

function resolveExaConfig(searchConfig?: SearchConfigRecord): ExaConfig {
  const exa = searchConfig?.exa;
  return exa && typeof exa === "object" && !Array.isArray(exa) ? (exa as ExaConfig) : {};
}

function resolveExaApiKey(exa?: ExaConfig): string | undefined {
  return (
    readConfiguredSecretString(exa?.apiKey, "plugins.entries.exa.config.webSearch.apiKey") ??
    readProviderEnvValue(["EXA_API_KEY"])
  );
}

function invalidBaseUrlPayload(value: string) {
  return {
    error: "invalid_base_url",
    message: `plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL. Got: ${value}`,
    docs: "https://docs.openclaw.ai/tools/exa-search",
  };
}

function resolveExaSearchEndpoint(
  exa?: ExaConfig,
): { endpoint: string; mode: ExaEndpointMode } | { error: string; message: string; docs: string } {
  const localConfigured = normalizeOptionalString(exa?.localBaseUrl);
  const configured = normalizeOptionalString(exa?.baseUrl);
  if (configured && localConfigured) {
    return invalidBaseUrlPayload("baseUrl and localBaseUrl are mutually exclusive");
  }
  if (localConfigured) {
    let parsed: URL;
    try {
      parsed = new URL(localConfigured);
    } catch {
      return invalidBaseUrlPayload(localConfigured);
    }
    if (
      parsed.protocol !== "http:" ||
      (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") ||
      parsed.port === "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return invalidBaseUrlPayload(localConfigured);
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = pathname.endsWith("/search")
      ? pathname
      : `${pathname === "" ? "" : pathname}/search`;
    return { endpoint: parsed.toString(), mode: "loopback" };
  }
  if (!configured) {
    return { endpoint: EXA_SEARCH_ENDPOINT, mode: "strict" };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(configured) && !/^https?:\/\//i.test(configured)) {
    return invalidBaseUrlPayload(configured);
  }
  const candidate = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalidBaseUrlPayload(configured);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalidBaseUrlPayload(configured);
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/search")
    ? pathname
    : `${pathname === "" ? "" : pathname}/search`;
  parsed.hash = "";
  return { endpoint: parsed.toString(), mode: "strict" };
}

function resolveExaDescription(result: ExaSearchResult): string {
  const highlights = result.highlights;
  if (Array.isArray(highlights)) {
    const highlightText = highlights
      .map((entry) => normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
    if (highlightText) {
      return highlightText;
    }
  }
  const summary = normalizeOptionalString(result.summary);
  if (summary) {
    return summary;
  }
  return normalizeOptionalString(result.text) ?? "";
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function invalidContentsPayload(message: string) {
  return {
    error: "invalid_contents",
    message,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function isErrorPayload(value: unknown): value is { error: string; message: string; docs: string } {
  return Boolean(
    value && typeof value === "object" && "error" in value && "message" in value && "docs" in value,
  );
}

function resolveExaSearchCount(value: unknown, fallback: number, maximum: number): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    return fallback;
  }
  return Math.min(maximum, parsed);
}

function parseExaContents(
  rawContents: unknown,
  strictLocalBroker = false,
): { value?: ExaContentsArgs } | { error: string; message: string; docs: string } {
  if (rawContents === undefined) {
    return { value: undefined };
  }
  if (!rawContents || typeof rawContents !== "object" || Array.isArray(rawContents)) {
    return invalidContentsPayload(
      "contents must be an object with optional text, highlights, and summary fields.",
    );
  }

  const raw = rawContents as Record<string, unknown>;
  const allowedKeys = new Set(["text", "highlights", "summary"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return invalidContentsPayload(
        `contents has unknown field "${key}". Only "text", "highlights", and "summary" are allowed.`,
      );
    }
  }

  const parsed: ExaContentsArgs = {};

  const parseText = (
    value: unknown,
  ): ExaTextContentsOption | { error: string; message: string; docs: string } => {
    if (typeof value === "boolean") {
      return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidContentsPayload("contents.text must be a boolean or an object.");
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== "maxCharacters") {
        return invalidContentsPayload(
          `contents.text has unknown field "${key}". Only "maxCharacters" is allowed.`,
        );
      }
    }
    const maxCharacters = parsePositiveInteger(obj.maxCharacters);
    if (
      "maxCharacters" in obj &&
      (maxCharacters === undefined || (strictLocalBroker && maxCharacters > MAX_TEXT_CHARACTERS))
    ) {
      return invalidContentsPayload(
        `contents.text.maxCharacters must be an integer from 1 to ${MAX_TEXT_CHARACTERS}.`,
      );
    }
    return maxCharacters ? { maxCharacters } : {};
  };

  const parseHighlights = (
    value: unknown,
  ): ExaHighlightsContentsOption | { error: string; message: string; docs: string } => {
    if (typeof value === "boolean") {
      return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidContentsPayload("contents.highlights must be a boolean or an object.");
    }
    const obj = value as Record<string, unknown>;
    const allowed = new Set(["maxCharacters", "query", "numSentences", "highlightsPerUrl"]);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        return invalidContentsPayload(
          `contents.highlights has unknown field "${key}". Allowed fields are "maxCharacters", "query", "numSentences", and "highlightsPerUrl".`,
        );
      }
    }
    const maxCharacters = parsePositiveInteger(obj.maxCharacters);
    const numSentences = parsePositiveInteger(obj.numSentences);
    const highlightsPerUrl = parsePositiveInteger(obj.highlightsPerUrl);
    if (
      "maxCharacters" in obj &&
      (maxCharacters === undefined ||
        (strictLocalBroker && maxCharacters > MAX_HIGHLIGHT_CHARACTERS))
    ) {
      return invalidContentsPayload(
        `contents.highlights.maxCharacters must be an integer from 1 to ${MAX_HIGHLIGHT_CHARACTERS}.`,
      );
    }
    if (
      "numSentences" in obj &&
      (numSentences === undefined || (strictLocalBroker && numSentences > MAX_HIGHLIGHT_SENTENCES))
    ) {
      return invalidContentsPayload(
        `contents.highlights.numSentences must be an integer from 1 to ${MAX_HIGHLIGHT_SENTENCES}.`,
      );
    }
    if (
      "highlightsPerUrl" in obj &&
      (highlightsPerUrl === undefined ||
        (strictLocalBroker && highlightsPerUrl > MAX_HIGHLIGHTS_PER_URL))
    ) {
      return invalidContentsPayload(
        `contents.highlights.highlightsPerUrl must be an integer from 1 to ${MAX_HIGHLIGHTS_PER_URL}.`,
      );
    }
    if (
      "query" in obj &&
      (typeof obj.query !== "string" ||
        (strictLocalBroker && unicodeLength(obj.query) > MAX_CONTENT_QUERY_CHARACTERS))
    ) {
      return invalidContentsPayload(
        `contents.highlights.query must be a string of at most ${MAX_CONTENT_QUERY_CHARACTERS} characters.`,
      );
    }
    return {
      ...(maxCharacters ? { maxCharacters } : {}),
      ...(typeof obj.query === "string" ? { query: obj.query } : {}),
      ...(numSentences ? { numSentences } : {}),
      ...(highlightsPerUrl ? { highlightsPerUrl } : {}),
    };
  };

  const parseSummary = (
    value: unknown,
  ): ExaSummaryContentsOption | { error: string; message: string; docs: string } => {
    if (typeof value === "boolean") {
      return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidContentsPayload("contents.summary must be a boolean or an object.");
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== "query") {
        return invalidContentsPayload(
          `contents.summary has unknown field "${key}". Only "query" is allowed.`,
        );
      }
    }
    if (
      "query" in obj &&
      (typeof obj.query !== "string" ||
        (strictLocalBroker && unicodeLength(obj.query) > MAX_CONTENT_QUERY_CHARACTERS))
    ) {
      return invalidContentsPayload(
        `contents.summary.query must be a string of at most ${MAX_CONTENT_QUERY_CHARACTERS} characters.`,
      );
    }
    return typeof obj.query === "string" ? { query: obj.query } : {};
  };

  if ("text" in raw) {
    const parsedText = parseText(raw.text);
    if (isErrorPayload(parsedText)) {
      return parsedText;
    }
    parsed.text = parsedText;
  }
  if ("highlights" in raw) {
    const parsedHighlights = parseHighlights(raw.highlights);
    if (isErrorPayload(parsedHighlights)) {
      return parsedHighlights;
    }
    parsed.highlights = parsedHighlights;
  }
  if ("summary" in raw) {
    const parsedSummary = parseSummary(raw.summary);
    if (isErrorPayload(parsedSummary)) {
      return parsedSummary;
    }
    parsed.summary = parsedSummary;
  }

  return { value: parsed };
}

function normalizeExaResults(payload: unknown): ExaSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as ExaSearchResponse).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter((entry): entry is ExaSearchResult =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

function resolveFreshnessStartDate(freshness: ExaFreshness): string {
  const now = new Date();
  if (freshness === "day") {
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString();
  }
  if (freshness === "week") {
    now.setUTCDate(now.getUTCDate() - 7);
    return now.toISOString();
  }
  if (freshness === "month") {
    const currentDay = now.getUTCDate();
    now.setUTCDate(1);
    now.setUTCMonth(now.getUTCMonth() - 1);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    now.setUTCDate(Math.min(currentDay, lastDayOfTargetMonth));
    return now.toISOString();
  }
  now.setUTCFullYear(now.getUTCFullYear() - 1);
  return now.toISOString();
}

async function runExaSearch(params: {
  apiKey: string;
  endpoint: string;
  endpointMode: ExaEndpointMode;
  query: string;
  count: number;
  freshness?: ExaFreshness;
  dateAfter?: string;
  dateBefore?: string;
  type: ExaSearchType;
  contents?: ExaContentsArgs;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<ExaSearchResult[]> {
  const body: Record<string, unknown> = {
    query: params.query,
    numResults: params.count,
    type: params.type,
    contents: params.contents ?? { highlights: true },
  };

  if (params.dateAfter) {
    body.startPublishedDate = params.dateAfter;
  } else if (params.freshness) {
    body.startPublishedDate = resolveFreshnessStartDate(params.freshness);
  }
  if (params.dateBefore) {
    body.endPublishedDate = params.dateBefore;
  }

  const withEndpoint =
    params.endpointMode === "loopback"
      ? withLoopbackWebSearchEndpoint
      : withTrustedWebSearchEndpoint;
  return withEndpoint(
    {
      url: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": params.apiKey,
          "x-exa-integration": "openclaw",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await readExaErrorDetail(res);
        throw new Error(`Exa API error (${res.status}): ${detail || res.statusText}`);
      }
      return readExaSearchResults(res);
    },
  );
}

function missingExaKeyPayload() {
  return {
    error: "missing_exa_api_key",
    message:
      "web_search (exa) needs an Exa API key. Set EXA_API_KEY in the Gateway environment, or configure plugins.entries.exa.config.webSearch.apiKey.",
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function buildExaCacheKey(params: {
  endpoint: string;
  type: ExaSearchType;
  query: string;
  count: number;
  freshness?: ExaFreshness;
  dateAfter?: string;
  dateBefore?: string;
  contents?: ExaContentsArgs;
}): string {
  const contents = params.contents ?? { highlights: true };

  return buildSearchCacheKey([
    "exa",
    params.endpoint,
    params.type,
    params.query,
    params.count,
    params.freshness,
    params.dateAfter,
    params.dateBefore,
    JSON.stringify(contents),
  ]);
}

export async function executeExaWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "exa",
    resolveProviderWebSearchPluginConfig(ctx.config, "exa"),
  ) as SearchConfigRecord | undefined;
  const params = args;
  const exaConfig = resolveExaConfig(searchConfig);
  const apiKey = resolveExaApiKey(exaConfig);
  if (!apiKey) {
    return missingExaKeyPayload();
  }
  const endpointResult = resolveExaSearchEndpoint(exaConfig);
  if ("error" in endpointResult) {
    return endpointResult;
  }
  const endpoint = endpointResult.endpoint;
  const endpointMode = endpointResult.mode;

  const query = readStringParam(params, "query", { required: true });
  const rawType = readStringParam(params, "type");
  if (
    endpointMode === "loopback" &&
    rawType &&
    !EXA_SEARCH_TYPES.includes(rawType as ExaSearchType)
  ) {
    return {
      error: "invalid_type",
      message: `type must be one of ${EXA_SEARCH_TYPES.join(", ")}.`,
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  const type: ExaSearchType = EXA_SEARCH_TYPES.includes(rawType as ExaSearchType)
    ? (rawType as ExaSearchType)
    : "auto";
  if (endpointMode === "loopback" && unicodeLength(query) > MAX_QUERY_CHARACTERS) {
    return {
      error: "invalid_query",
      message: `query must contain at most ${MAX_QUERY_CHARACTERS} characters.`,
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  const maxSearchCount = resolveExaMaxSearchCount(exaConfig);
  const count =
    readPositiveIntegerParam(params, "count", {
      max: maxSearchCount,
      message: `count must be an integer from 1 to ${maxSearchCount}.`,
    }) ??
    searchConfig?.maxResults ??
    undefined;
  const rawFreshness = readStringParam(params, "freshness");
  const freshness = normalizeExaFreshness(rawFreshness);
  if (rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: 'freshness must be one of "day", "week", "month", or "year".',
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const rawDateAfter = readStringParam(params, "date_after");
  const rawDateBefore = readStringParam(params, "date_before");
  if (freshness && (rawDateAfter || rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message:
        "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  const parsedDateRange = parseIsoDateRange({
    rawDateAfter,
    rawDateBefore,
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be earlier than or equal to date_before.",
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }
  const { dateAfter, dateBefore } = parsedDateRange;

  const parsedContents = parseExaContents(params.contents, endpointMode === "loopback");
  if (isErrorPayload(parsedContents)) {
    return parsedContents;
  }
  const contents =
    parsedContents.value && Object.keys(parsedContents.value).length > 0
      ? parsedContents.value
      : undefined;

  const resolvedCount = resolveExaSearchCount(count, DEFAULT_SEARCH_COUNT, maxSearchCount);
  const cacheKey = buildExaCacheKey({
    endpoint,
    type,
    query,
    count: resolvedCount,
    freshness,
    dateAfter,
    dateBefore,
    contents,
  });
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const results = await runExaSearch({
    apiKey,
    endpoint,
    endpointMode,
    query,
    count: resolvedCount,
    freshness,
    dateAfter,
    dateBefore,
    type,
    contents,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
    signal,
  });

  signal?.throwIfAborted();
  const payload = {
    query,
    provider: "exa",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "exa",
      wrapped: true,
    },
    results: results.map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      const description = resolveExaDescription(entry);
      const summary = normalizeOptionalString(entry.summary) ?? "";
      const highlightScores = Array.isArray(entry.highlightScores)
        ? entry.highlightScores.filter(
            (score): score is number => typeof score === "number" && Number.isFinite(score),
          )
        : [];
      const published =
        typeof entry.publishedDate === "string" && entry.publishedDate
          ? entry.publishedDate
          : undefined;
      return Object.assign(
        {
          title: title ? wrapWebContent(title, `web_search`) : ``,
          url,
          description: description ? wrapWebContent(description, `web_search`) : ``,
          published,
          siteName: resolveSiteName(url) || undefined,
        },
        summary ? { summary: wrapWebContent(summary, `web_search`) } : {},
        highlightScores.length > 0 ? { highlightScores } : {},
      );
    }),
  };

  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}

export const testing = {
  parseExaContents,
  buildExaCacheKey,
  resolveExaApiKey,
  resolveExaDescription,
  resolveExaSearchCount,
  resolveExaSearchEndpoint,
  resolveFreshnessStartDate,
  readExaErrorDetail,
  readExaSearchResults,
} as const;
