import type { Page, Request } from "playwright-core";

/**
 * The page's recent first-party data exchanges, kept so a task the agent did
 * once can be saved as a flow and replayed without the page. Only fetch, XHR
 * and main-frame documents are kept, and only JSON or HTML bodies, within a
 * small per-page memory budget: the managed browser runs in tight VMs.
 */
export type CapturedExchange = {
  id: string;
  method: string;
  url: string;
  kind: "data" | "document";
  /** Request headers as the browser sent them, cookies included; never leave the browser process unfiltered. */
  headers: Record<string, string>;
  postData?: string;
  status?: number;
  contentType?: string;
  body?: string;
  failed?: boolean;
};

const MAX_EXCHANGES = 60;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_POST_BYTES = 64 * 1024;
const MAX_PAGE_BODY_BYTES = 2 * 1024 * 1024;

type CaptureState = {
  exchanges: CapturedExchange[];
  next: number;
  byRequest: WeakMap<Request, CapturedExchange>;
};

const captures = new WeakMap<Page, CaptureState>();

function keptBody(contentType: string | undefined, kind: CapturedExchange["kind"]): boolean {
  const type = (contentType ?? "").toLowerCase();
  if (kind === "document") {
    return type.includes("text/html");
  }
  return type.includes("json") || type.includes("javascript") || type.startsWith("text/plain");
}

function trimBodies(state: CaptureState): void {
  let total = 0;
  for (const exchange of state.exchanges.toReversed()) {
    total += exchange.body?.length ?? 0;
    if (total > MAX_PAGE_BODY_BYTES) {
      exchange.body = undefined;
    }
  }
}

/** Start keeping the page's data exchanges; idempotent. */
export function attachFlowCapture(page: Page): void {
  if (captures.has(page)) {
    return;
  }
  const state: CaptureState = { exchanges: [], next: 0, byRequest: new WeakMap() };
  captures.set(page, state);
  page.on("request", (req: Request) => {
    const type = req.resourceType();
    let mainDocument: boolean;
    try {
      mainDocument = type === "document" && req.frame() === page.mainFrame();
    } catch {
      // A service worker's request has no frame and is not the page's own.
      return;
    }
    if (!mainDocument && type !== "fetch" && type !== "xhr") {
      return;
    }
    const url = req.url();
    if (!/^https?:/i.test(url)) {
      return;
    }
    state.next += 1;
    const postData = req.postData() ?? undefined;
    const exchange: CapturedExchange = {
      id: `c${state.next}`,
      method: req.method(),
      url,
      kind: mainDocument ? "document" : "data",
      headers: req.headers(),
      ...(postData !== undefined && postData.length <= MAX_POST_BYTES ? { postData } : {}),
    };
    state.byRequest.set(req, exchange);
    state.exchanges.push(exchange);
    if (state.exchanges.length > MAX_EXCHANGES) {
      state.exchanges.splice(0, state.exchanges.length - MAX_EXCHANGES);
    }
  });
  page.on("requestfinished", (req: Request) => {
    const exchange = state.byRequest.get(req);
    if (!exchange) {
      return;
    }
    void (async () => {
      try {
        exchange.headers = await req.allHeaders();
        const response = await req.response();
        if (!response) {
          return;
        }
        exchange.status = response.status();
        exchange.contentType = response.headers()["content-type"];
        if (!keptBody(exchange.contentType, exchange.kind)) {
          return;
        }
        const length = Number(response.headers()["content-length"] ?? "0");
        if (length > MAX_BODY_BYTES) {
          return;
        }
        const body = (await response.body()).toString("utf8");
        if (body.length <= MAX_BODY_BYTES) {
          exchange.body = body;
          trimBodies(state);
        }
      } catch {
        // A closed page or an evicted body only loses this exchange's detail.
      }
    })();
  });
  page.on("requestfailed", (req: Request) => {
    const exchange = state.byRequest.get(req);
    if (exchange) {
      exchange.failed = true;
    }
  });
}

/** The page's kept exchanges, oldest first. */
export function readFlowCapture(page: Page): CapturedExchange[] {
  return [...(captures.get(page)?.exchanges ?? [])];
}
