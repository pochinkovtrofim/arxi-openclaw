/** Saved flows: save the page's data request once, then run it without driving the page. */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { hasEnvHttpProxyConfigured } from "openclaw/plugin-sdk/fetch-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { wrapBrowserExternalJson } from "./browser-tool.snapshot.js";
import { browserFlowCapture, browserFlowPageFetch } from "./browser/client-actions.js";
import type { BrowserClientTarget } from "./browser/client-request.js";
import {
  classifyFlowResponse,
  selectFlowData,
  type FlowOutcome,
  type Json,
} from "./browser/flow-data.js";
import { deleteFlow, describeFlows, listFlows, readFlow, writeFlow } from "./browser/flow-store.js";
import {
  buildFlow,
  renderFlowRequest,
  siteOf,
  type FlowRequest,
  type FlowTier,
  type SavedFlow,
} from "./browser/flows.js";

export const BROWSER_FLOW_ACTIONS = ["flow_save", "flow_run", "flow_list", "flow_delete"] as const;
export type BrowserFlowAction = (typeof BROWSER_FLOW_ACTIONS)[number];

/**
 * The Arxi host runs a flow request from the owner's own computer (Ro for Mac
 * or Linux) when the agent asks for it; only an owner runtime has the route.
 */
export const DEVICE_FETCH_URL = "http://127.0.0.1:18080/device/fetch";

const MAX_RESPONSE_CHARS = 1024 * 1024;

type FlowInput = {
  name?: string;
  site?: string;
  description?: string;
  params?: Record<string, string>;
  where?: Record<string, string>;
  select?: string[];
  output?: string;
  via?: "auto" | "device";
  allowWrite?: boolean;
};

function readStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`flow.${label} must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "number" || typeof entry === "boolean") {
      out[key] = String(entry);
    } else if (typeof entry === "string") {
      out[key] = entry;
    } else {
      throw new Error(`flow.${label}.${key} must be a string`);
    }
  }
  return out;
}

export function readFlowInput(raw: unknown): FlowInput {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const via = normalizeOptionalString(record.via);
  if (via !== undefined && via !== "auto" && via !== "device") {
    throw new Error("flow.via must be auto or device");
  }
  const select = Array.isArray(record.select)
    ? record.select.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : undefined;
  return {
    name: normalizeOptionalString(record.name),
    site: normalizeOptionalString(record.site)?.toLowerCase(),
    description: normalizeOptionalString(record.description),
    params: readStringRecord(record.params, "params"),
    where: readStringRecord(record.where, "where"),
    select,
    output: normalizeOptionalString(record.output),
    via: via as FlowInput["via"],
    allowWrite: record.allowWrite === true,
  };
}

type TierAnswer =
  | { ok: true; status: number; contentType?: string; retryAfter?: string; body: string }
  | { ok: false; error: string; detail?: string };

async function httpTier(
  request: FlowRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TierAnswer> {
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: request.url,
      init: {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
      },
      timeoutMs,
      signal,
      // A write is sent once and never follows a redirect: where it landed is unknown.
      maxRedirects: request.write ? 0 : 5,
      // In an Arxi VM public traffic leaves through the host's proxy, which
      // resolves names and refuses private addresses itself.
      mode: hasEnvHttpProxyConfigured() ? "trusted_env_proxy" : "strict",
      auditContext: "browser-flow",
    });
    try {
      const body = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
      return {
        ok: true,
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        retryAfter: response.headers.get("retry-after") ?? undefined,
        body,
      };
    } finally {
      await release();
    }
  } catch (err) {
    signal?.throwIfAborted();
    return { ok: false, error: "network", detail: formatErrorMessage(err) };
  }
}

async function deviceTier(
  request: FlowRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TierAnswer> {
  try {
    const response = await fetch(DEVICE_FETCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        timeoutMs,
        write: request.write,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 15_000)])
        : AbortSignal.timeout(timeoutMs + 15_000),
    });
    if (response.status === 404) {
      return {
        ok: false,
        error: "device_unavailable",
        detail: "this runtime has no owner computer",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: "device_unavailable",
        detail: `relay answered ${response.status}`,
      };
    }
    const answer = (await response.json()) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    if (answer.ok === true && typeof answer.status === "number") {
      return {
        ok: true,
        status: answer.status,
        contentType: text(answer.contentType),
        retryAfter: text(answer.retryAfter),
        body: (text(answer.body) ?? "").slice(0, MAX_RESPONSE_CHARS),
      };
    }
    return {
      ok: false,
      error: text(answer.error) ?? "device_failed",
      detail: answer.detail === undefined ? undefined : (text(answer.detail) ?? JSON.stringify(answer.detail)),
    };
  } catch (err) {
    signal?.throwIfAborted();
    // The relay may have passed it on before its answer was lost.
    return { ok: false, error: "relay_unanswered", detail: formatErrorMessage(err) };
  }
}

type FlowContext = {
  target: BrowserClientTarget;
  profile?: string;
  signal?: AbortSignal;
  targetId?: string;
  timeoutMs?: number;
  limit?: number;
  /** Where flows live; tests point it at a temporary directory. */
  root?: string;
};

async function pageTier(
  request: FlowRequest,
  context: FlowContext,
  timeoutMs: number,
): Promise<TierAnswer> {
  try {
    const answer = await browserFlowPageFetch(context.target, {
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      write: request.write,
      targetId: context.targetId,
      timeoutMs,
      profile: context.profile,
      signal: context.signal,
    });
    if (answer.ok) {
      return answer;
    }
    return answer.error === "not_on_site"
      ? {
          ok: false,
          error: "not_on_site",
          detail: `the tab is on ${siteOf(answer.pageUrl) || "no site"}`,
        }
      : { ok: false, error: "network", detail: answer.detail };
  } catch (err) {
    context.signal?.throwIfAborted();
    return { ok: false, error: "page_unavailable", detail: formatErrorMessage(err) };
  }
}

/**
 * Tiers in order: the last one that worked first, the device only when asked.
 * A write goes to one tier only, the page when the recording was signed in.
 */
export function flowTierOrder(flow: SavedFlow, via: FlowInput["via"]): FlowTier[] {
  if (via === "device") {
    return ["device"];
  }
  if (flow.request.write) {
    return flow.request.session || flow.tier === "page" ? ["page"] : ["http"];
  }
  return flow.tier === "page" ? ["page", "http"] : ["http", "page"];
}

type Attempt = {
  tier: FlowTier;
  outcome: FlowOutcome | { kind: "unanswered"; error: string; detail?: string };
};

// A read moves on to the next tier after these; anything else is the answer.
const NEXT_TIER = new Set(["unanswered", "auth", "blocked", "server_error", "not_json", "drift"]);

function attemptSummary(attempt: Attempt): string {
  const { tier, outcome } = attempt;
  switch (outcome.kind) {
    case "unanswered":
      return `${tier}: ${outcome.error}${outcome.detail ? ` (${outcome.detail.slice(0, 160)})` : ""}`;
    case "drift":
      return `${tier}: response changed shape (missing ${outcome.missing})`;
    case "rate_limited":
      return `${tier}: rate limited${outcome.retryAfter ? `, retry after ${outcome.retryAfter}` : ""}`;
    case "ok":
      return `${tier}: ok`;
    default:
      return `${tier}: ${outcome.kind} (${outcome.status})`;
  }
}

function nextStepHint(attempts: Attempt[], flow: SavedFlow, via: FlowInput["via"]): string {
  const kinds = new Set(attempts.map((a) => a.outcome.kind));
  const pageNotOnSite = attempts.some(
    (a) =>
      a.tier === "page" && a.outcome.kind === "unanswered" && a.outcome.error === "not_on_site",
  );
  if (kinds.has("drift")) {
    return "The site changed: do the task in the page, then flow_save again.";
  }
  if (pageNotOnSite && (kinds.has("auth") || flow.request.session)) {
    return `Open ${flow.startUrl} (signed in) and run again: the page tier sends the site's own cookies.`;
  }
  if ((kinds.has("blocked") || kinds.has("auth")) && via !== "device") {
    return "The site refuses this server; try via=device to send it from the owner's computer, or use the page.";
  }
  return "Use the page for this task.";
}

function sendOnTier(tier: FlowTier, request: FlowRequest, context: FlowContext, timeoutMs: number) {
  return tier === "http"
    ? httpTier(request, timeoutMs, context.signal)
    : tier === "device"
      ? deviceTier(request, timeoutMs, context.signal)
      : pageTier(request, context, timeoutMs);
}

// Answers that prove a write never left: nothing to check on the site.
const WRITE_NOT_SENT = new Set([
  "not_on_site",
  "device_unavailable",
  "device_none",
  "device_offline",
  "device_busy",
  "device_invalid",
  "device_outdated",
]);

type WriteVerdict =
  | { kind: "applied"; data: Json; drift?: string }
  | { kind: "write_not_sent" | "write_rejected" | "outcome_unknown"; detail: string };

/** What one answer says about a write: applied, refused, never sent, or unknown. */
export function writeVerdict(flow: SavedFlow, answer: TierAnswer): WriteVerdict {
  if (!answer.ok) {
    const refusedBeforeSending = /_fetch_refused/.test(answer.detail ?? "");
    return WRITE_NOT_SENT.has(answer.error) || refusedBeforeSending
      ? { kind: "write_not_sent", detail: answer.error }
      : { kind: "outcome_unknown", detail: answer.error };
  }
  const { status } = answer;
  // A redirect after a POST is how many sites say it worked; 0 is one the page did not follow.
  if (status === 0 || (status >= 300 && status < 400) || status === 408 || status >= 500) {
    return { kind: "outcome_unknown", detail: `answered ${status}` };
  }
  if (status >= 400) {
    return { kind: "write_rejected", detail: `answered ${status}` };
  }
  const outcome = classifyFlowResponse({ flow, status, body: answer.body });
  if (outcome.kind === "ok") {
    return { kind: "applied", data: outcome.data };
  }
  if (outcome.kind === "drift") {
    // A 2xx with JSON in another shape: the site took it and answered differently.
    return { kind: "outcome_unknown", detail: `applied, but the answer changed shape (missing ${outcome.missing})` };
  }
  return { kind: "outcome_unknown", detail: `answered ${status} without the recorded data` };
}

const WRITE_HINT: Record<Exclude<WriteVerdict["kind"], "applied">, string> = {
  write_not_sent: "Nothing was sent. Open the site's page (signed in) and run it again, or do it in the page.",
  write_rejected: "The site refused it; nothing changed. Check the params, or do it in the page.",
  outcome_unknown: "The change may or may not have happened: check the site before running it again.",
};

async function runWrite(flow: SavedFlow, request: FlowRequest, input: FlowInput, context: FlowContext, timeoutMs: number, root?: string) {
  const [tier] = flowTierOrder(flow, input.via);
  const verdict = writeVerdict(flow, await sendOnTier(tier, request, context, timeoutMs));
  if (verdict.kind !== "applied") {
    if (verdict.detail.startsWith("applied")) {
      await writeFlow({ ...flow, verified: false, drift: verdict.detail, updatedAt: new Date().toISOString() }, root).catch(() => {});
    }
    return jsonResult({ ok: false, error: verdict.kind, flow: flow.name, via: tier, detail: verdict.detail, hint: WRITE_HINT[verdict.kind] });
  }
  await writeFlow({ ...flow, tier, verified: true, updatedAt: new Date().toISOString() }, root).catch(() => {});
  return flowResult(flow, tier, verdict.data, input, context, true);
}

function flowResult(flow: SavedFlow, tier: FlowTier, data: Json, input: FlowInput, context: FlowContext, verified: boolean, drift?: string) {
  const selected = selectFlowData(flow.shape, data, {
    where: input.where,
    select: input.select,
    limit: context.limit,
  });
  const wrapped = wrapBrowserExternalJson({
    kind: "flow",
    payload: {
      flow: flow.name,
      via: tier,
      ...(selected.total !== undefined
        ? { total: selected.total, matched: selected.matched, returned: selected.returned }
        : {}),
      ...(selected.truncated ? { truncated: true } : {}),
      ...(verified ? {} : { verified: false, drift }),
      data: selected.data,
    },
  });
  return {
    content: [{ type: "text" as const, text: wrapped.wrappedText }],
    details: { ...wrapped.safeDetails, flow: flow.name, via: tier, verified },
  };
}

async function runFlow(flow: SavedFlow, input: FlowInput, context: FlowContext, root?: string) {
  const request = renderFlowRequest(flow, input.params ?? {});
  const timeoutMs = Math.max(1_000, Math.min(context.timeoutMs ?? 20_000, 60_000));
  if (request.write) {
    if (!input.allowWrite) {
      return jsonResult({
        ok: false,
        error: "write_not_allowed",
        flow: flow.name,
        hint: "This flow changes something on the site. Run it with flow.allowWrite=true only when the owner's task asks for that change.",
      });
    }
    return await runWrite(flow, request, input, context, timeoutMs, root);
  }
  const attempts: Attempt[] = [];
  let winner: { tier: FlowTier; data: Json } | undefined;
  for (const tier of flowTierOrder(flow, input.via)) {
    const answer = await sendOnTier(tier, request, context, timeoutMs);
    if (!answer.ok) {
      attempts.push({ tier, outcome: { kind: "unanswered", error: answer.error, detail: answer.detail } });
      continue;
    }
    const outcome = classifyFlowResponse({
      flow,
      status: answer.status,
      body: answer.body,
      retryAfter: answer.retryAfter,
    });
    attempts.push({ tier, outcome });
    if (outcome.kind === "ok") {
      winner = { tier, data: outcome.data };
      break;
    }
    if (!NEXT_TIER.has(outcome.kind)) {
      break;
    }
  }
  const drifted = attempts.find((a) => a.outcome.kind === "drift");
  const drift = drifted?.outcome.kind === "drift" ? `missing ${drifted.outcome.missing}` : undefined;
  const updated: SavedFlow = {
    ...flow,
    updatedAt: new Date().toISOString(),
    ...(winner ? { tier: winner.tier } : {}),
    verified: drift ? false : winner ? true : flow.verified,
  };
  if (drift) {
    updated.drift = drift;
  } else if (winner) {
    delete updated.drift;
  }
  await writeFlow(updated, root).catch(() => {});
  if (!winner) {
    const last = attempts.at(-1);
    return jsonResult({
      ok: false,
      error: last?.outcome.kind === "unanswered" ? last.outcome.error : (last?.outcome.kind ?? "failed"),
      flow: flow.name,
      verified: updated.verified,
      tried: attempts.map(attemptSummary),
      hint: nextStepHint(attempts, flow, input.via),
    });
  }
  return flowResult(flow, winner.tier, winner.data, input, context, updated.verified, drift);
}

async function saveFlow(input: FlowInput, context: FlowContext, root?: string) {
  if (!input.name) {
    throw new Error("flow.name required");
  }
  const capture = await browserFlowCapture(context.target, {
    targetId: context.targetId,
    profile: context.profile,
    signal: context.signal,
  });
  let result: ReturnType<typeof buildFlow>;
  try {
    result = buildFlow({
      name: input.name,
      pageUrl: capture.pageUrl,
      exchanges: capture.exchanges,
      values: input.params,
      output: input.output,
      description: input.description,
    });
  } catch (err) {
    const extra = err as { candidates?: unknown; skipped?: unknown };
    return jsonResult({
      ok: false,
      error: formatErrorMessage(err),
      ...(extra.candidates ? { candidates: extra.candidates } : {}),
      ...(extra.skipped ? { skipped: extra.skipped } : {}),
      hint: "Do the task in this tab first (search, filter, open the list), then save; pass flow.output with a candidate id to pick another request.",
    });
  }
  await writeFlow(result.flow, root);
  const { flow } = result;
  let path = flow.request.url;
  try {
    const url = new URL(flow.request.url);
    path = decodeURI(`${url.pathname}${url.search}`);
  } catch {}
  return jsonResult({
    ok: true,
    saved: flow.name,
    site: flow.site,
    request: `${flow.request.method} ${path}`,
    params: flow.params,
    ...(result.unusedParams.length > 0
      ? {
          unusedParams: result.unusedParams,
          note: "These values were not in the saved request; they are not params.",
        }
      : {}),
    ...(flow.shape.items !== undefined
      ? { items: flow.shape.items || "(the body is the list)", itemFields: flow.shape.itemKeys }
      : { fields: flow.shape.keys }),
    ...(flow.request.write ? { write: true } : {}),
    ...(flow.request.session
      ? { session: "the recording was signed in; runs fall back to the page for its cookies" }
      : {}),
    candidates: result.candidates,
    run: `action=flow_run flow={name:"${flow.name}"${flow.params.length > 0 ? `, params:{${flow.params.map((p) => `${p}:…`).join(", ")}}` : ""}}`,
  });
}

/** Run one saved-flow action. */
export async function executeFlowAction(
  action: BrowserFlowAction,
  rawFlow: unknown,
  context: FlowContext,
): Promise<AgentToolResult<unknown>> {
  const input = readFlowInput(rawFlow);
  const root = context.root;
  switch (action) {
    case "flow_save":
      return await saveFlow(input, context, root);
    case "flow_list": {
      const flows = await listFlows(input.site, root);
      return jsonResult({
        ok: true,
        flows: flows.map((flow) => ({
          name: flow.name,
          site: flow.site,
          params: flow.params,
          description: flow.description,
          verified: flow.verified,
          write: flow.request.write || undefined,
          via: flow.tier,
        })),
      });
    }
    case "flow_delete": {
      if (!input.name) {
        throw new Error("flow.name required");
      }
      const flow = await readFlow(input.name, input.site, root);
      return jsonResult({
        ok: flow ? await deleteFlow(flow.name, flow.site, root) : false,
        flow: input.name,
      });
    }
    case "flow_run": {
      if (!input.name) {
        throw new Error("flow.name required");
      }
      const flow = await readFlow(input.name, input.site, root);
      if (!flow) {
        const known = await listFlows(input.site, root);
        return jsonResult({
          ok: false,
          error: "no_such_flow",
          flow: input.name,
          flows: known.map((f) => `${f.site}/${f.name}`).slice(0, 20),
        });
      }
      return await runFlow(flow, input, context, root);
    }
  }
  throw new Error("unknown flow action");
}

/** The site's saved flows as one line for the agent, or nothing. */
export async function savedFlowsHint(pageUrl: string | undefined, root?: string) {
  const site = pageUrl ? siteOf(pageUrl) : "";
  if (!site) {
    return undefined;
  }
  const flows = await listFlows(site, root).catch(() => []);
  if (flows.length === 0) {
    return undefined;
  }
  return {
    text: `[saved flows on ${site}: ${describeFlows(flows)}. If one fits the task, use action=flow_run instead of driving the page.]`,
    flows: flows.map((flow) => ({ name: flow.name, params: flow.params, verified: flow.verified })),
  };
}

/** Add the site's saved flows to an open or navigate result. */
export async function appendSavedFlowsHint(
  result: AgentToolResult<unknown>,
  pageUrl: string | undefined,
): Promise<AgentToolResult<unknown>> {
  const hint = await savedFlowsHint(pageUrl);
  if (!hint) {
    return result;
  }
  const details =
    result.details && typeof result.details === "object"
      ? (result.details as Record<string, unknown>)
      : {};
  return {
    content: [...result.content, { type: "text", text: hint.text }],
    details: { ...details, savedFlows: hint.flows },
  };
}
