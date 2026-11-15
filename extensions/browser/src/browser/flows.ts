import type { CapturedExchange } from "./flow-capture.js";
import { isRecord, parseJson, responseData, shapeOf, type Json } from "./flow-data.js";

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
// A password field also as Rails names it: user[password]= or user%5Bpassword%5D=.
const LOGIN_BODY = /["']?(password|passwd|pwd|one-time-code|otp)(["'\]]|%5D)?\s*[:=]/i;
// Body fields that carry the session rather than the task: dropped like credential headers.
// Pagination cursors such as pageToken stay.
const SECRET_BODY_KEY =
  /(^|_)(csrf|xsrf)|authenticity_token|^fb_dtsg$|^lsd$|^jazoest$|session_?id|^sid$|^(access|id|refresh|auth)_?token$|^token$|nonce|signature|^sig$|secret|api_?key/i;
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
    headers[name] = name === "referer" ? originOf(value) : value;
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
      const body = withoutSecretFields(exchange.postData, headers["content-type"] ?? "");
      out.postData = body.text;
      out.session ||= body.dropped;
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

function originOf(raw: string): string {
  try {
    return `${new URL(raw).origin}/`;
  } catch {
    return "";
  }
}

function dropSecretKeys(value: Json): { value: Json; dropped: boolean } {
  let dropped = false;
  const walk = (entry: Json): Json => {
    if (Array.isArray(entry)) {
      return entry.map(walk);
    }
    if (!isRecord(entry)) {
      return entry;
    }
    const out: { [key: string]: Json } = {};
    for (const [key, child] of Object.entries(entry)) {
      if (SECRET_BODY_KEY.test(key)) {
        dropped = true;
      } else {
        out[key] = walk(child);
      }
    }
    return out;
  };
  return { value: walk(value), dropped };
}

/** A JSON or form body without the fields that carry the session. */
function withoutSecretFields(body: string, contentType: string): { text: string; dropped: boolean } {
  const json = parseJson(body);
  if (json !== undefined) {
    const clean = dropSecretKeys(json);
    return clean.dropped ? { text: JSON.stringify(clean.value), dropped: true } : { text: body, dropped: false };
  }
  if (/x-www-form-urlencoded/i.test(contentType)) {
    const form = new URLSearchParams(body);
    const secret = Array.from(form.keys()).filter((key) => SECRET_BODY_KEY.test(key));
    if (secret.length === 0) {
      return { text: body, dropped: false };
    }
    for (const key of secret) {
      form.delete(key);
    }
    return { text: form.toString(), dropped: true };
  }
  return { text: body, dropped: false };
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

const READ_PATH = /(^|\/)(search|query|find|list|lookup|suggest|autocomplete)(\/|$)/i;
const GRAPHQL_PATH = /(^|\/)graphql(\/|$)/i;

/**
 * Whether sending the request changes something on the site. A GraphQL
 * request reads only when its query text is there and is not a mutation; a
 * persisted query or a doc_id names an operation this cannot see, so it
 * counts as a write. Other POSTs read only on a search-like path.
 */
export function isWrite(exchange: Pick<FlowExchange, "method" | "url" | "postData">): boolean {
  const method = exchange.method;
  let pathname = "";
  try {
    pathname = new URL(exchange.url).pathname;
  } catch {}
  if (WRITE_SEGMENT.test(pathname)) {
    return true;
  }
  if (method === "GET" || method === "HEAD") {
    return false;
  }
  const body = parseJson(exchange.postData);
  const entries = Array.isArray(body) ? body : [body];
  if (entries.every((entry) => isRecord(entry) && typeof entry.query === "string")) {
    return entries.some(
      (entry) => isRecord(entry) && typeof entry.query === "string" && /^\s*mutation\b/.test(entry.query),
    );
  }
  const opaqueOperation =
    entries.some((entry) => isRecord(entry) && ("extensions" in entry || "operationName" in entry)) ||
    /(^|&)doc_id=/.test(exchange.postData ?? "");
  if (opaqueOperation || GRAPHQL_PATH.test(pathname)) {
    return true;
  }
  return !(method === "POST" && READ_PATH.test(pathname));
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
    for (const [key, current] of Array.from(url.searchParams.entries())) {
      if (current === value) {
        url.searchParams.set(key, placeholderToken(name));
        found.add(name);
      }
    }
    let changed = false;
    const segments = url.pathname.split("/").map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {}
      if (decoded !== value || value === "") {
        return segment;
      }
      changed = true;
      found.add(name);
      return placeholderToken(`${name}_path`);
    });
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

function templateBody(
  body: string,
  contentType: string,
  params: Placeholder[],
  found: Set<string>,
): string {
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
      for (const [key, current] of Array.from(form.entries())) {
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

const PLACEHOLDER =
  /"\{\{([A-Za-z][A-Za-z0-9_]*)\|(json|jsonnum)\}\}"|\{\{([A-Za-z][A-Za-z0-9_]*)\|(url|form)\}\}/g;

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

export type FlowCandidate = {
  id: string;
  method: string;
  path: string;
  bytes: number;
  keys: string[];
  write: boolean;
};

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
    haystacks.some(
      (text) => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)),
    ),
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
  type Eligible = { exchange: FlowExchange; data: Json; size: number; analytics: boolean };
  const eligible: Eligible[] = [];
  for (const exchange of params.exchanges) {
    if (siteOf(exchange.url) !== site) {
      skip("other_site");
      continue;
    }
    if (exchange.skip) {
      skip(exchange.skip);
      continue;
    }
    if (
      exchange.failed ||
      exchange.status === undefined ||
      exchange.status < 200 ||
      exchange.status >= 300
    ) {
      skip("not_answered");
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
    let pathname = "";
    try {
      pathname = new URL(exchange.url).pathname;
    } catch {}
    // Analytics never wins an automatic pick, but flow.output may still name one
    // (an events list or a stats API looks the same).
    const analytics = exchange.kind === "data" && ANALYTICS_PATH.test(pathname);
    if (analytics) {
      skip("analytics");
    }
    eligible.push({ exchange, data, size: JSON.stringify(data).length, analytics });
  }
  const valueList = Object.values(values);
  const automatic = eligible.filter((entry) => !entry.analytics);
  let pool: Eligible[];
  if (valueList.length > 0) {
    // The request that sent the most of the typed values; a value it did not
    // send is reported back as not a param.
    const counts = automatic.map(({ exchange }) => containedCount(exchange, valueList));
    const best = Math.max(0, ...counts);
    pool = best > 0 ? automatic.filter((_, i) => counts[i] === best) : [];
  } else {
    const lastNavigation = automatic.map(({ exchange }) => exchange.kind).lastIndexOf("document");
    pool = lastNavigation >= 0 ? automatic.slice(lastNavigation) : automatic;
  }
  const candidates = eligible
    .slice(-12)
    .map(({ exchange, data }) => candidateOf(exchange, data))
    .toReversed();
  let chosen: Eligible | undefined;
  if (params.output) {
    chosen = eligible.find(({ exchange }) => exchange.id === params.output);
    if (!chosen) {
      throw new Error(
        `no saved-able request ${params.output}; candidates: ${candidates.map((c) => c.id).join(", ") || "none"}`,
      );
    }
  } else {
    // A data response over the page's embedded data, a read over a write, then
    // the most data: a page's whole HTML says nothing about how much it holds.
    const reads = pool.filter(({ exchange }) => !isWrite(exchange));
    const readable = reads.length > 0 ? reads : pool;
    const apis = readable.filter(({ exchange }) => exchange.kind === "data");
    chosen = (apis.length > 0 ? apis : readable).toSorted((a, b) => b.size - a.size)[0];
  }
  if (!chosen) {
    const why =
      valueList.length > 0
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
  const body =
    exchange.postData !== undefined
      ? templateBody(exchange.postData, exchange.headers["content-type"] ?? "", placeholders, found)
      : undefined;
  const now = (params.now ?? new Date()).toISOString();
  const flow: SavedFlow = {
    version: FLOW_VERSION,
    name,
    ...(params.description ? { description: params.description.slice(0, 200) } : {}),
    site,
    startUrl: urlWithoutQuery(pageUrl),
    params: placeholders
      .map((p) => p.name)
      .filter((p) => found.has(p))
      .toSorted(),
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

