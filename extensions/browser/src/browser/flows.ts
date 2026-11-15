import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { CapturedExchange } from "./flow-capture.js";

/**
 * Saved flows: a data request the agent's task made once, kept as a template
 * so the next run sends it directly (or from the page) and returns only the
 * fields asked for. A flow keeps no cookies, tokens or typed secrets; a value
 * the agent names as a param becomes a placeholder filled on every run.
 */
export const FLOW_VERSION = 1;
export const FLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export type FlowTier = "http" | "page" | "device";

export type FlowRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** json: the response body is the data; html: the data is JSON the page embeds. */
  kind: "json" | "html";
  write: boolean;
  /** The recording sent cookies or credential headers that the flow does not keep. */
  session: boolean;
};

export type FlowShape = {
  keys: string[];
  /** Dotted path of the main list of records; "" when the body itself is the list. */
  items?: string;
  itemKeys?: string[];
};

export type SavedFlow = {
  version: typeof FLOW_VERSION;
  name: string;
  description?: string;
  site: string;
  startUrl: string;
  params: string[];
  request: FlowRequest;
  shape: FlowShape;
  tier?: FlowTier;
  verified: boolean;
  drift?: string;
  createdAt: string;
  updatedAt: string;
};

/** A captured exchange with everything secret removed, safe to leave the browser process. */
export type FlowExchange = {
  id: string;
  method: string;
  url: string;
  kind: "data" | "document";
  headers: Record<string, string>;
  session: boolean;
  postData?: string;
  status?: number;
  contentType?: string;
  body?: string;
  failed?: boolean;
  skip?: "credential_in_url" | "login";
};

const SECRET_HEADER =
  /^(cookie|authorization|proxy-authorization)$|csrf|xsrf|token|api[-_]?key|secret|signature|^x-sig|session|auth|nonce|hmac/i;
const DROPPED_HEADER =
  /^(host|content-length|connection|keep-alive|transfer-encoding|accept-encoding|upgrade|te|trailer|:.*)$/i;
const CREDENTIAL_QUERY =
  /^(token|access_token|id_token|refresh_token|auth|authorization|csrf|xsrf|_csrf|api[_-]?key|apikey|key|sig|signature|password|passwd|pass|session|sid|secret)$/i;
const LOGIN_BODY = /["']?(password|passwd|pwd|one-time-code|otp)["']?\s*[:=]/i;
const ANALYTICS_PATH =
  /(^|[/._-])(collect|analytics|telemetry|beacon|track(ing)?|metrics|pixel|events?|log(s|ging)?|rum|stats|ping|heartbeat)([/._?-]|$)/i;
const WRITE_SEGMENT = /(^|\/)(logout|signout|sign-out|unsubscribe|delete|remove)(\/|$)/i;
const TWO_LEVEL_SUFFIX = /^(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;

/** The site a host belongs to: its last two labels, three under a two-level suffix such as co.uk. */
export function siteOf(rawUrl: string): string {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    return host;
  }
  const labels = host.split(".");
  if (labels.length <= 2) {
    return host;
  }
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LEVEL_SUFFIX.test(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** Remove cookies, credential headers and login bodies; keep a note that they were there. */
export function sanitizeExchange(exchange: CapturedExchange): FlowExchange {
  const headers: Record<string, string> = {};
  let session = false;
  for (const [rawName, value] of Object.entries(exchange.headers)) {
    const name = rawName.toLowerCase();
    if (DROPPED_HEADER.test(name)) {
      continue;
    }
    if (SECRET_HEADER.test(name)) {
      session = true;
      continue;
    }
    headers[name] = value;
  }
  const out: FlowExchange = {
    id: exchange.id,
    method: exchange.method.toUpperCase(),
    url: exchange.url,
    kind: exchange.kind,
    headers,
    session,
    ...(exchange.status !== undefined ? { status: exchange.status } : {}),
    ...(exchange.contentType ? { contentType: exchange.contentType } : {}),
    ...(exchange.failed ? { failed: true } : {}),
  };
  try {
    for (const key of new URL(exchange.url).searchParams.keys()) {
      if (CREDENTIAL_QUERY.test(key)) {
        out.skip = "credential_in_url";
      }
    }
  } catch {
    out.skip = "credential_in_url";
  }
  if (exchange.postData !== undefined) {
    if (LOGIN_BODY.test(exchange.postData)) {
      out.skip ??= "login";
    } else {
      out.postData = exchange.postData;
    }
  }
  if (out.skip) {
    // A skipped exchange carries nothing beyond why it was skipped.
    delete out.postData;
    out.url = urlWithoutQuery(exchange.url);
  } else if (exchange.body !== undefined) {
    out.body = exchange.body;
  }
  return out;
}

function urlWithoutQuery(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function parseJson(text: string | undefined): Json | undefined {
  if (text === undefined) {
    return undefined;
  }
  const trimmed = text.replace(/^\)\]\}',?\s*/, "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as Json;
  } catch {
    return undefined;
  }
}

/** JSON a server-rendered page embeds: Next.js data first, then JSON-LD blocks. */
export function extractEmbeddedJson(html: string): Json | undefined {
  const next = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  const nextData = next ? parseJson(next[1]) : undefined;
  if (nextData !== undefined) {
    return nextData;
  }
  const blocks: Json[] = [];
  const ld = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let match = ld.exec(html); match; match = ld.exec(html)) {
    const parsed = parseJson(match[1]);
    if (parsed !== undefined) {
      blocks.push(parsed);
    }
  }
  if (blocks.length === 0) {
    return undefined;
  }
  return blocks.length === 1 ? blocks[0] : blocks;
}

/** The data a response carries for a flow request of this kind. */
export function responseData(kind: FlowRequest["kind"], body: string): Json | undefined {
  return kind === "html" ? extractEmbeddedJson(body) : parseJson(body);
}

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPath(value: Json | undefined, dotted: string): Json | undefined {
  if (dotted === "") {
    return value;
  }
  let current: Json | undefined = value;
  for (const part of dotted.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function findItems(value: Json, prefix: string, depth: number): { path: string; size: number } | undefined {
  let best: { path: string; size: number } | undefined;
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isRecord)) {
      best = { path: prefix, size: value.length };
    }
    return best;
  }
  if (!isRecord(value) || depth >= 5) {
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findItems(child, prefix ? `${prefix}.${key}` : key, depth + 1);
    if (found && (!best || found.size > best.size)) {
      best = found;
    }
  }
  return best;
}

export function shapeOf(data: Json): FlowShape {
  const keys = isRecord(data) ? Object.keys(data).sort().slice(0, 40) : [];
  const found = findItems(data, "", 0);
  if (!found) {
    return { keys };
  }
  const list = getPath(data, found.path);
  const itemKeys = new Set<string>();
  for (const item of (Array.isArray(list) ? list : []).slice(0, 5)) {
    if (isRecord(item)) {
      for (const key of Object.keys(item)) {
        itemKeys.add(key);
      }
    }
  }
  return { keys, items: found.path, itemKeys: [...itemKeys].sort().slice(0, 40) };
}

/** Whether a response still has the recorded shape; names the first thing missing. */
export function checkShape(shape: FlowShape, data: Json | undefined): { ok: true } | { ok: false; missing: string } {
  if (data === undefined) {
    return { ok: false, missing: "data" };
  }
  for (const key of shape.keys) {
    if (!isRecord(data) || !(key in data)) {
      return { ok: false, missing: key };
    }
  }
  if (shape.items !== undefined) {
    const list = getPath(data, shape.items);
    if (!Array.isArray(list)) {
      return { ok: false, missing: shape.items || "list" };
    }
    const first = list.find(isRecord);
    if (first && shape.itemKeys && shape.itemKeys.length > 0) {
      const present = shape.itemKeys.filter((key) => key in first).length;
      if (present * 2 < shape.itemKeys.length) {
        const missing = shape.itemKeys.find((key) => !(key in first)) ?? "item";
        return { ok: false, missing: `${shape.items ? `${shape.items}.` : ""}[].${missing}` };
      }
    }
  }
  return { ok: true };
}

function isWrite(exchange: FlowExchange): boolean {
  const method = exchange.method;
  let pathname = "";
  try {
    pathname = new URL(exchange.url).pathname;
  } catch {}
  if (method === "GET" || method === "HEAD") {
    return WRITE_SEGMENT.test(pathname);
  }
  // A GraphQL query sent by POST reads; a mutation writes.
  const body = parseJson(exchange.postData);
  const queries = Array.isArray(body) ? body : [body];
  const graphql = queries.every((entry) => isRecord(entry) && typeof entry.query === "string");
  if (graphql) {
    return queries.some((entry) => /^\s*mutation\b/.test(String((entry as { query: string }).query)));
  }
  if (method === "POST" && /(^|\/)(search|query|graphql|find|list|lookup|suggest|autocomplete)(\/|$|\?)/i.test(pathname)) {
    return false;
  }
  return true;
}

type Placeholder = { name: string; value: string };

function placeholderToken(name: string): string {
  return `__ARXIFLOW_${name}__`;
}

/**
 * Replace a param's recorded value with its placeholder wherever it is a whole
 * query value or path segment. Setting a query value re-serializes the query
 * as a form (spaces as +), so query placeholders render the same way.
 */
function templateUrl(raw: string, params: Placeholder[], found: Set<string>): string {
  const url = new URL(raw);
  for (const { name, value } of params) {
    for (const [key, current] of [...url.searchParams.entries()]) {
      if (current === value) {
        url.searchParams.set(key, placeholderToken(name));
        found.add(name);
      }
    }
    const segments = url.pathname.split("/");
    let changed = false;
    for (let i = 0; i < segments.length; i += 1) {
      let decoded = segments[i];
      try {
        decoded = decodeURIComponent(segments[i]);
      } catch {}
      if (decoded === value && value !== "") {
        segments[i] = placeholderToken(`${name}_path`);
        changed = true;
        found.add(name);
      }
    }
    if (changed) {
      url.pathname = segments.join("/");
    }
  }
  let out = url.toString();
  for (const { name } of params) {
    out = out.split(placeholderToken(`${name}_path`)).join(`{{${name}|url}}`);
    out = out.split(placeholderToken(name)).join(`{{${name}|form}}`);
  }
  return out;
}

function templateJsonValue(value: Json, params: Placeholder[], found: Set<string>): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => templateJsonValue(entry, params, found));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, templateJsonValue(entry, params, found)]),
    );
  }
  for (const { name, value: wanted } of params) {
    if (typeof value === "string" && value === wanted) {
      found.add(name);
      return placeholderToken(`${name}|json`);
    }
    if (typeof value === "number" && String(value) === wanted) {
      found.add(name);
      return placeholderToken(`${name}|jsonnum`);
    }
  }
  return value;
}

function templateBody(body: string, contentType: string, params: Placeholder[], found: Set<string>): string {
  const json = parseJson(body);
  if (json !== undefined) {
    let out = JSON.stringify(templateJsonValue(json, params, found));
    for (const { name } of params) {
      for (const mode of ["json", "jsonnum"]) {
        out = out.split(`"${placeholderToken(`${name}|${mode}`)}"`).join(`"{{${name}|${mode}}}"`);
      }
    }
    return out;
  }
  if (/x-www-form-urlencoded/i.test(contentType)) {
    const form = new URLSearchParams(body);
    for (const { name, value } of params) {
      for (const [key, current] of [...form.entries()]) {
        if (current === value) {
          form.set(key, placeholderToken(name));
          found.add(name);
        }
      }
    }
    let out = form.toString();
    for (const { name } of params) {
      out = out.split(placeholderToken(name)).join(`{{${name}|form}}`);
    }
    return out;
  }
  return body;
}

const PLACEHOLDER = /"\{\{([A-Za-z][A-Za-z0-9_]*)\|(json|jsonnum)\}\}"|\{\{([A-Za-z][A-Za-z0-9_]*)\|(url|form)\}\}/g;

/** Fill a template's placeholders, each encoded for the place it stands in. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, jsonName, jsonMode, urlName, urlMode) => {
    const name = (jsonName ?? urlName) as string;
    const value = values[name] ?? "";
    switch ((jsonMode ?? urlMode) as string) {
      case "jsonnum":
        return /^-?\d+(\.\d+)?$/.test(value) ? value : JSON.stringify(value);
      case "json":
        return JSON.stringify(value);
      case "form":
        return encodeURIComponent(value).replace(/%20/g, "+");
      default:
        return encodeURIComponent(value);
    }
  });
}

export function renderFlowRequest(flow: SavedFlow, values: Record<string, string>): FlowRequest {
  const missing = flow.params.filter((name) => typeof values[name] !== "string");
  if (missing.length > 0) {
    throw new Error(`flow ${flow.name} needs params: ${missing.join(", ")}`);
  }
  return {
    ...flow.request,
    url: renderTemplate(flow.request.url, values),
    ...(flow.request.body !== undefined ? { body: renderTemplate(flow.request.body, values) } : {}),
  };
}

export type FlowCandidate = { id: string; method: string; path: string; bytes: number; keys: string[]; write: boolean };

export type FlowSaveResult = {
  flow: SavedFlow;
  candidates: FlowCandidate[];
  unusedParams: string[];
  skipped: Record<string, number>;
};

function candidateOf(exchange: FlowExchange, data: Json): FlowCandidate {
  let pathname = exchange.url;
  try {
    const url = new URL(exchange.url);
    pathname = url.pathname;
  } catch {}
  return {
    id: exchange.id,
    method: exchange.method,
    path: pathname,
    bytes: exchange.body?.length ?? 0,
    keys: (isRecord(data) ? Object.keys(data) : Array.isArray(data) ? ["[]"] : []).slice(0, 6),
    write: isWrite(exchange),
  };
}

function containedCount(exchange: FlowExchange, values: string[]): number {
  const haystacks = [exchange.url, exchange.postData ?? ""];
  try {
    haystacks.push(decodeURIComponent(exchange.url.replace(/\+/g, " ")));
  } catch {}
  return values.filter((value) =>
    haystacks.some((text) => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))),
  ).length;
}

/**
 * Turn the page's recent exchanges into a flow. With params, the request is
 * the one that sent the param values (what the agent typed); otherwise the
 * largest first-party data response since the last navigation. `output`
 * picks a candidate by id instead.
 */
export function buildFlow(params: {
  name: string;
  pageUrl: string;
  exchanges: FlowExchange[];
  values?: Record<string, string>;
  output?: string;
  description?: string;
  now?: Date;
}): FlowSaveResult {
  const { name, pageUrl } = params;
  if (!FLOW_NAME_PATTERN.test(name)) {
    throw new Error("flow name must be lowercase letters, digits, - or _ (up to 64)");
  }
  const values = params.values ?? {};
  for (const [key, value] of Object.entries(values)) {
    if (!PARAM_NAME_PATTERN.test(key)) {
      throw new Error(`param name ${key} must be a letter followed by letters, digits or _`);
    }
    if (typeof value !== "string" || value === "") {
      throw new Error(`param ${key} needs the value you typed or picked in the task`);
    }
  }
  const site = siteOf(pageUrl);
  if (!site) {
    throw new Error("flow_save needs a tab on a website");
  }
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const eligible: Array<{ exchange: FlowExchange; data: Json }> = [];
  for (const exchange of params.exchanges) {
    if (siteOf(exchange.url) !== site) {
      skip("other_site");
      continue;
    }
    if (exchange.skip) {
      skip(exchange.skip);
      continue;
    }
    if (exchange.failed || exchange.status === undefined || exchange.status < 200 || exchange.status >= 300) {
      skip("not_answered");
      continue;
    }
    let pathname = "";
    try {
      pathname = new URL(exchange.url).pathname;
    } catch {}
    if (exchange.kind === "data" && ANALYTICS_PATH.test(pathname)) {
      skip("analytics");
      continue;
    }
    if (exchange.body === undefined) {
      skip("no_body");
      continue;
    }
    const data = responseData(exchange.kind === "document" ? "html" : "json", exchange.body);
    if (data === undefined) {
      skip(exchange.kind === "document" ? "no_embedded_data" : "not_json");
      continue;
    }
    eligible.push({ exchange, data });
  }
  const valueList = Object.values(values);
  let pool = eligible;
  if (valueList.length > 0) {
    // The request that sent the most of the typed values; a value it did not
    // send is reported back as not a param.
    const counts = eligible.map(({ exchange }) => containedCount(exchange, valueList));
    const best = Math.max(0, ...counts);
    pool = best > 0 ? eligible.filter((_, i) => counts[i] === best) : [];
  } else {
    const lastNavigation = eligible.map(({ exchange }) => exchange.kind).lastIndexOf("document");
    pool = lastNavigation >= 0 ? eligible.slice(lastNavigation) : eligible;
  }
  const candidates = eligible.slice(-12).map(({ exchange, data }) => candidateOf(exchange, data)).reverse();
  let chosen: { exchange: FlowExchange; data: Json } | undefined;
  if (params.output) {
    chosen = eligible.find(({ exchange }) => exchange.id === params.output);
    if (!chosen) {
      throw new Error(`no saved-able request ${params.output}; candidates: ${candidates.map((c) => c.id).join(", ") || "none"}`);
    }
  } else {
    const reads = pool.filter(({ exchange }) => !isWrite(exchange));
    const ranked = (reads.length > 0 ? reads : pool).toSorted(
      (a, b) => (b.exchange.body?.length ?? 0) - (a.exchange.body?.length ?? 0),
    );
    chosen = ranked[0];
  }
  if (!chosen) {
    const why = valueList.length > 0
      ? "no first-party data request sent those param values"
      : "no first-party JSON or embedded page data was recorded since the last navigation";
    throw Object.assign(new Error(`nothing to save: ${why}`), { candidates, skipped });
  }
  const placeholders = Object.entries(values)
    .map(([key, value]) => ({ name: key, value }))
    .toSorted((a, b) => b.value.length - a.value.length);
  const found = new Set<string>();
  const { exchange, data } = chosen;
  const url = templateUrl(exchange.url, placeholders, found);
  const body = exchange.postData !== undefined
    ? templateBody(exchange.postData, exchange.headers["content-type"] ?? "", placeholders, found)
    : undefined;
  const now = (params.now ?? new Date()).toISOString();
  const flow: SavedFlow = {
    version: FLOW_VERSION,
    name,
    ...(params.description ? { description: params.description.slice(0, 200) } : {}),
    site,
    startUrl: urlWithoutQuery(pageUrl),
    params: placeholders.map((p) => p.name).filter((p) => found.has(p)).sort(),
    request: {
      method: exchange.method,
      url,
      headers: exchange.headers,
      ...(body !== undefined ? { body } : {}),
      kind: exchange.kind === "document" ? "html" : "json",
      write: isWrite(exchange),
      session: exchange.session,
    },
    shape: shapeOf(data),
    verified: true,
    createdAt: now,
    updatedAt: now,
  };
  return {
    flow,
    candidates,
    unusedParams: placeholders.map((p) => p.name).filter((p) => !found.has(p)),
    skipped,
  };
}

export type FlowSelection = {
  where?: Record<string, string>;
  select?: string[];
  limit?: number;
};

function matches(item: Json, where: Record<string, string>): boolean {
  return Object.entries(where).every(([field, wanted]) => {
    const value = getPath(item, field);
    const test = (entry: Json | undefined): boolean => {
      if (typeof entry === "string") {
        return entry.toLowerCase().includes(wanted.toLowerCase());
      }
      if (typeof entry === "number" || typeof entry === "boolean") {
        return String(entry) === wanted;
      }
      return Array.isArray(entry) ? entry.some(test) : false;
    };
    return test(value);
  });
}

function pick(item: Json, fields: string[]): Json {
  if (fields.length === 0) {
    return item;
  }
  const out: { [key: string]: Json } = {};
  for (const field of fields) {
    const value = getPath(item, field);
    if (value !== undefined) {
      out[field] = value;
    }
  }
  return out;
}

const MAX_RESULT_CHARS = 12_000;

/** Only the records and fields asked for, within the result budget. */
export function selectFlowData(shape: FlowShape, data: Json, selection: FlowSelection): {
  data: Json;
  total?: number;
  matched?: number;
  returned?: number;
  truncated: boolean;
} {
  const fields = selection.select ?? [];
  if (shape.items === undefined) {
    const value = pick(data, fields);
    const text = JSON.stringify(value);
    return text.length > MAX_RESULT_CHARS
      ? { data: text.slice(0, MAX_RESULT_CHARS), truncated: true }
      : { data: value, truncated: false };
  }
  const list = getPath(data, shape.items);
  const all = Array.isArray(list) ? list : [];
  const filtered = selection.where && Object.keys(selection.where).length > 0
    ? all.filter((item) => matches(item, selection.where!))
    : all;
  const limit = Math.max(1, Math.min(selection.limit ?? 10, 100));
  let items = filtered.slice(0, limit).map((item) => pick(item, fields));
  let truncated = false;
  while (items.length > 1 && JSON.stringify(items).length > MAX_RESULT_CHARS) {
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    truncated = true;
  }
  const text = JSON.stringify(items);
  if (text.length > MAX_RESULT_CHARS) {
    return { data: text.slice(0, MAX_RESULT_CHARS), total: all.length, matched: filtered.length, returned: 1, truncated: true };
  }
  return { data: items, total: all.length, matched: filtered.length, returned: items.length, truncated };
}

export type FlowOutcome =
  | { kind: "ok"; data: Json }
  | { kind: "drift"; missing: string }
  | { kind: "rate_limited"; retryAfter?: string }
  | { kind: "auth" | "blocked" | "server_error" | "not_json" | "rejected"; status: number };

const CHALLENGE = /cf-chl|challenge-platform|captcha|just a moment|attention required|access denied|are you a robot|px-captcha/i;
const LOGIN_PAGE = /<input[^>]+type=["']?password/i;

/** What one tier's answer means for the flow. */
export function classifyFlowResponse(params: {
  flow: SavedFlow;
  status: number;
  contentType?: string;
  body: string;
  retryAfter?: string;
}): FlowOutcome {
  const { status, body } = params;
  if (status === 429) {
    return { kind: "rate_limited", ...(params.retryAfter ? { retryAfter: params.retryAfter } : {}) };
  }
  if ((status === 403 || status === 503) && CHALLENGE.test(body.slice(0, 20_000))) {
    return { kind: "blocked", status };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", status };
  }
  if (status >= 500) {
    return { kind: "server_error", status };
  }
  if (status < 200 || status >= 300) {
    return { kind: "rejected", status };
  }
  const data = responseData(params.flow.request.kind, body);
  if (data === undefined) {
    if (CHALLENGE.test(body.slice(0, 20_000))) {
      return { kind: "blocked", status };
    }
    return LOGIN_PAGE.test(body) ? { kind: "auth", status } : { kind: "not_json", status };
  }
  const shape = checkShape(params.flow.shape, data);
  return shape.ok ? { kind: "ok", data } : { kind: "drift", missing: shape.missing };
}

// Storage: one JSON file per flow under the principal's state directory, so
// flows belong to the same owner or group as the browser profile and survive
// sleep and runtime replacement.

export function flowsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.resolve(resolveStateDir(env)), "browser", "flows");
}

function flowPath(root: string, site: string, name: string): string {
  if (!/^[a-z0-9.-]+$/.test(site) || site.startsWith(".") || !FLOW_NAME_PATTERN.test(name)) {
    throw new Error("invalid flow site or name");
  }
  return path.join(root, site, `${name}.json`);
}

const FLOW_KEYS = new Set([
  "version", "name", "description", "site", "startUrl", "params", "request", "shape",
  "tier", "verified", "drift", "createdAt", "updatedAt",
]);

function parseFlow(text: string): SavedFlow | undefined {
  try {
    const value = JSON.parse(text) as SavedFlow;
    if (value.version !== FLOW_VERSION || !Object.keys(value).every((key) => FLOW_KEYS.has(key))) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export async function writeFlow(flow: SavedFlow, root = flowsRoot()): Promise<string> {
  const file = flowPath(root, flow.site, flow.name);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  return file;
}

export async function readFlow(name: string, site: string | undefined, root = flowsRoot()): Promise<SavedFlow | undefined> {
  if (site) {
    try {
      return parseFlow(await fs.readFile(flowPath(root, site, name), "utf8"));
    } catch {
      return undefined;
    }
  }
  const matches = (await listFlows(undefined, root)).filter((flow) => flow.name === name);
  if (matches.length > 1) {
    throw new Error(`several sites have a flow named ${name}: ${matches.map((f) => f.site).join(", ")}; pass flow.site`);
  }
  return matches[0];
}

export async function listFlows(site: string | undefined, root = flowsRoot()): Promise<SavedFlow[]> {
  let sites: string[];
  try {
    sites = site ? [site] : await fs.readdir(root);
  } catch {
    return [];
  }
  const flows: SavedFlow[] = [];
  for (const entry of sites) {
    if (!/^[a-z0-9.-]+$/.test(entry)) {
      continue;
    }
    let files: string[];
    try {
      files = await fs.readdir(path.join(root, entry));
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      try {
        const flow = parseFlow(await fs.readFile(path.join(root, entry, file), "utf8"));
        if (flow) {
          flows.push(flow);
        }
      } catch {}
    }
  }
  return flows;
}

export async function deleteFlow(name: string, site: string, root = flowsRoot()): Promise<boolean> {
  try {
    await fs.unlink(flowPath(root, site, name));
    return true;
  } catch {
    return false;
  }
}

/** A short line per flow, for the agent to find them when it opens the site. */
export function describeFlows(flows: SavedFlow[]): string {
  return flows
    .map((flow) => {
      const params = flow.params.length > 0 ? `(${flow.params.join(", ")})` : "()";
      const state = flow.verified ? "" : " [unverified]";
      const write = flow.request.write ? " [write]" : "";
      return `${flow.name}${params}${write}${state}${flow.description ? ` — ${flow.description}` : ""}`;
    })
    .join("; ");
}
