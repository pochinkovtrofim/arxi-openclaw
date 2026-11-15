import { readFlowCapture } from "./flow-capture.js";
import { sanitizeExchange, siteOf, type FlowExchange } from "./flows.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";

/** The tab's recent data exchanges with cookies and credentials removed. */
export async function getFlowCaptureViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ exchanges: FlowExchange[]; pageUrl: string }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  return { exchanges: readFlowCapture(page).map(sanitizeExchange), pageUrl: page.url() };
}

const PAGE_FETCH_MAX_CHARS = 1024 * 1024;

/**
 * Send one saved-flow request from the page itself, with the page's own
 * cookies. Only to the site the tab is on: a flow never reaches another site
 * through the page.
 */
export async function flowPageFetchViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<
  | { ok: true; status: number; contentType?: string; retryAfter?: string; body: string; finalUrl: string }
  | { ok: false; error: "not_on_site" | "network"; detail?: string; pageUrl: string }
> {
  const page = await getPageForTargetId(opts);
  const pageUrl = page.url();
  const site = siteOf(opts.url);
  if (!site || siteOf(pageUrl) !== site) {
    return { ok: false, error: "not_on_site", pageUrl };
  }
  const result = await page.evaluate(
    async ({ url, method, headers, body, timeoutMs, maxChars }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ?? undefined,
          credentials: "include",
          redirect: "follow",
          signal: controller.signal,
        });
        const text = await response.text();
        return {
          ok: true as const,
          status: response.status,
          contentType: response.headers.get("content-type") ?? undefined,
          retryAfter: response.headers.get("retry-after") ?? undefined,
          body: text.slice(0, maxChars),
          finalUrl: response.url,
        };
      } catch (err) {
        return { ok: false as const, detail: String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      url: opts.url,
      method: opts.method,
      // The browser sets these itself and refuses a page that tries to.
      headers: Object.fromEntries(
        Object.entries(opts.headers).filter(
          ([name]) => !/^(origin|referer|user-agent|cookie|sec-|accept-language$)/i.test(name),
        ),
      ),
      body: opts.body ?? null,
      timeoutMs: Math.max(1_000, Math.min(opts.timeoutMs ?? 20_000, 60_000)),
      maxChars: PAGE_FETCH_MAX_CHARS,
    },
  );
  if (!result.ok) {
    return { ok: false, error: "network", detail: result.detail, pageUrl };
  }
  if (siteOf(result.finalUrl) !== site) {
    // A redirect left the site: report it as not answered rather than pass on another site's body.
    return { ok: false, error: "network", detail: "redirected off the site", pageUrl };
  }
  return result;
}
