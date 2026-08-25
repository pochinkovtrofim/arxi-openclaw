// Exa provider configuration shared by the lightweight schema and runtime.
export const EXA_MAX_CONFIGURABLE_SEARCH_COUNT = 100;

export type ExaWebSearchConfig = {
  apiKey?: string;
  baseUrl?: string;
  localBaseUrl?: string;
  maxResults?: number;
};

export function resolveExaMaxSearchCount(config?: ExaWebSearchConfig): number {
  const value = config?.maxResults;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(EXA_MAX_CONFIGURABLE_SEARCH_COUNT, value)
    : EXA_MAX_CONFIGURABLE_SEARCH_COUNT;
}

export function readExaWebSearchConfig(config?: Record<string, unknown>): ExaWebSearchConfig {
  const plugins = config?.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return {};
  }
  const entries = (plugins as Record<string, unknown>).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }
  const exa = (entries as Record<string, unknown>).exa;
  if (!exa || typeof exa !== "object" || Array.isArray(exa)) {
    return {};
  }
  const pluginConfig = (exa as Record<string, unknown>).config;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return {};
  }
  const webSearch = (pluginConfig as Record<string, unknown>).webSearch;
  return webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)
    ? (webSearch as ExaWebSearchConfig)
    : {};
}
