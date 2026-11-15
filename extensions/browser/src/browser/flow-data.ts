import type { FlowRequest, FlowShape, SavedFlow } from "./flows.js";

/** What a saved flow's response carries: its data, its shape, and only the asked-for part of it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function parseJson(text: string | undefined): Json | undefined {
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

export function isRecord(value: Json | undefined): value is { [key: string]: Json } {
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

function findItems(
  value: Json,
  prefix: string,
  depth: number,
): { path: string; size: number } | undefined {
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
  const keys = isRecord(data) ? Object.keys(data).toSorted().slice(0, 40) : [];
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
  return { keys, items: found.path, itemKeys: Array.from(itemKeys).toSorted().slice(0, 40) };
}

/** Whether a response still has the recorded shape; names the first thing missing. */
export function checkShape(
  shape: FlowShape,
  data: Json | undefined,
): { ok: true } | { ok: false; missing: string } {
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

export type FlowSelection = {
  where?: Record<string, string>;
  select?: string[];
  limit?: number;
};

function matchesWhere(item: Json, where: Record<string, string>): boolean {
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
export function selectFlowData(
  shape: FlowShape,
  data: Json,
  selection: FlowSelection,
): {
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
  const where = selection.where ?? {};
  const filtered =
    Object.keys(where).length > 0 ? all.filter((item) => matchesWhere(item, where)) : all;
  const limit = Math.max(1, Math.min(selection.limit ?? 10, 100));
  let items = filtered.slice(0, limit).map((item) => pick(item, fields));
  let truncated = false;
  while (items.length > 1 && JSON.stringify(items).length > MAX_RESULT_CHARS) {
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    truncated = true;
  }
  const text = JSON.stringify(items);
  if (text.length > MAX_RESULT_CHARS) {
    return {
      data: text.slice(0, MAX_RESULT_CHARS),
      total: all.length,
      matched: filtered.length,
      returned: 1,
      truncated: true,
    };
  }
  return {
    data: items,
    total: all.length,
    matched: filtered.length,
    returned: items.length,
    truncated,
  };
}

export type FlowOutcome =
  | { kind: "ok"; data: Json }
  | { kind: "drift"; missing: string }
  | { kind: "rate_limited"; retryAfter?: string }
  | { kind: "auth" | "blocked" | "server_error" | "not_json" | "rejected"; status: number };

const CHALLENGE =
  /cf-chl|challenge-platform|captcha|just a moment|attention required|access denied|are you a robot|px-captcha/i;
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
    return {
      kind: "rate_limited",
      ...(params.retryAfter ? { retryAfter: params.retryAfter } : {}),
    };
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
