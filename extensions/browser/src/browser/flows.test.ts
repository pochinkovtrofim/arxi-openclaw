import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapturedExchange } from "./flow-capture.js";
import {
  checkShape,
  classifyFlowResponse,
  extractEmbeddedJson,
  selectFlowData,
  shapeOf,
} from "./flow-data.js";
import { deleteFlow, listFlows, readFlow, writeFlow } from "./flow-store.js";
import {
  buildFlow,
  isWrite,
  renderFlowRequest,
  sanitizeExchange,
  siteOf,
  type FlowExchange,
} from "./flows.js";

function exchange(
  overrides: Partial<CapturedExchange> & { id: string; url: string },
): CapturedExchange {
  return {
    method: "GET",
    kind: "data",
    headers: { accept: "application/json", "user-agent": "Chrome" },
    status: 200,
    contentType: "application/json",
    body: "{}",
    ...overrides,
  };
}

const products = {
  query: "red shoes",
  total: 3,
  results: [
    { id: 1, title: "Red runner", price: { amount: 40 }, brand: "Acme" },
    { id: 2, title: "Red boot", price: { amount: 90 }, brand: "Bolt" },
    { id: 3, title: "Crimson sandal", price: { amount: 25 }, brand: "Acme" },
  ],
};

function recording(): FlowExchange[] {
  return [
    exchange({
      id: "c1",
      url: "https://www.shop.example/",
      kind: "document",
      contentType: "text/html",
      body: "<html></html>",
    }),
    exchange({
      id: "c2",
      url: "https://www.shop.example/api/config",
      body: JSON.stringify({ flags: {} }),
    }),
    exchange({
      id: "c3",
      url: "https://api.shop.example/v2/search?q=red+shoes&page=1",
      headers: {
        accept: "application/json",
        cookie: "sid=secret",
        authorization: "Bearer t",
        "x-csrf-token": "c",
      },
      body: JSON.stringify(products),
    }),
    exchange({
      id: "c4",
      url: "https://www.shop.example/collect?q=red+shoes",
      body: JSON.stringify({ ok: true, a: 1, b: 2, c: 3 }),
    }),
    exchange({
      id: "c5",
      url: "https://tracker.other.example/api?q=red+shoes",
      body: JSON.stringify(products),
    }),
  ].map(sanitizeExchange);
}

describe("saved flows", () => {
  it("knows a host's site", () => {
    expect(siteOf("https://api.shop.example/x")).toBe("shop.example");
    expect(siteOf("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(siteOf("http://127.0.0.1:8080/")).toBe("127.0.0.1");
    expect(siteOf("not a url")).toBe("");
  });

  it("drops cookies, credential headers, credential URLs and login bodies", () => {
    const clean = sanitizeExchange(
      exchange({
        id: "c1",
        url: "https://a.example/api",
        headers: {
          cookie: "s=1",
          Authorization: "x",
          "X-XSRF-TOKEN": "y",
          "content-type": "application/json",
          host: "a.example",
        },
      }),
    );
    expect(clean.headers).toEqual({ "content-type": "application/json" });
    expect(clean.session).toBe(true);
    const token = sanitizeExchange(
      exchange({ id: "c2", url: "https://a.example/api?access_token=abc&q=1" }),
    );
    expect(token.skip).toBe("credential_in_url");
    expect(token.url).toBe("https://a.example/api");
    expect(token.body).toBeUndefined();
    const login = sanitizeExchange(
      exchange({
        id: "c3",
        method: "POST",
        url: "https://a.example/login",
        postData: '{"email":"a","password":"hunter2"}',
      }),
    );
    expect(login.skip).toBe("login");
    expect(JSON.stringify(login)).not.toContain("hunter2");
  });

  it("saves the request that sent the typed value, as a template without secrets", () => {
    const { flow, unusedParams, skipped } = buildFlow({
      name: "search",
      pageUrl: "https://www.shop.example/s?q=red+shoes",
      exchanges: recording(),
      values: { query: "red shoes", color: "never-typed" },
    });
    expect(flow.request.url).toBe("https://api.shop.example/v2/search?q={{query|form}}&page=1");
    expect(flow.params).toEqual(["query"]);
    expect(unusedParams).toEqual(["color"]);
    expect(flow.request.session).toBe(true);
    expect(JSON.stringify(flow)).not.toMatch(/secret|Bearer|csrf/i);
    expect(flow.shape.items).toBe("results");
    expect(flow.startUrl).toBe("https://www.shop.example/s");
    expect(skipped.other_site).toBe(1);
    expect(skipped.analytics).toBe(1);
    const rendered = renderFlowRequest(flow, { query: "blue & green" });
    expect(rendered.url).toBe("https://api.shop.example/v2/search?q=blue+%26+green&page=1");
    expect(() => renderFlowRequest(flow, {})).toThrow(/needs params: query/);
  });

  it("templates JSON and form bodies and path segments with their own encoding", () => {
    const json = buildFlow({
      name: "graph",
      pageUrl: "https://x.example/",
      exchanges: [
        sanitizeExchange(
          exchange({
            id: "c1",
            method: "POST",
            url: "https://x.example/graphql",
            headers: { "content-type": "application/json" },
            postData: JSON.stringify({
              query: "query Find($q: String) { items }",
              variables: { q: "lamp", first: 20 },
            }),
            body: JSON.stringify({ data: { items: [{ id: "a" }] } }),
          }),
        ),
      ],
      values: { q: "lamp", count: "20" },
    }).flow;
    expect(json.request.write).toBe(false);
    expect(json.params).toEqual(["count", "q"]);
    const body = renderFlowRequest(json, { q: 'desk "lamp"', count: "5" }).body!;
    expect(JSON.parse(body).variables).toEqual({ q: 'desk "lamp"', first: 5 });

    const form = buildFlow({
      name: "form",
      pageUrl: "https://x.example/",
      exchanges: [
        sanitizeExchange(
          exchange({
            id: "c1",
            method: "POST",
            url: "https://x.example/users/ada/search",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            postData: "term=old+books&n=1",
            body: JSON.stringify({ hits: [{ t: 1 }] }),
          }),
        ),
      ],
      values: { term: "old books", user: "ada" },
    }).flow;
    const rendered = renderFlowRequest(form, { term: "new maps", user: "bob smith" });
    expect(rendered.body).toBe("term=new+maps&n=1");
    expect(rendered.url).toBe("https://x.example/users/bob%20smith/search");
  });

  it("without params saves the largest data response since the last navigation, and honours output", () => {
    const exchanges = recording();
    const auto = buildFlow({ name: "list", pageUrl: "https://www.shop.example/", exchanges });
    expect(auto.flow.request.url).toContain("/v2/search");
    expect(auto.candidates.map((c) => c.id)).toEqual(["c4", "c3", "c2"]);
    const picked = buildFlow({
      name: "config",
      pageUrl: "https://www.shop.example/",
      exchanges,
      output: "c2",
    });
    expect(picked.flow.request.url).toBe("https://www.shop.example/api/config");
    expect(() =>
      buildFlow({ name: "x", pageUrl: "https://www.shop.example/", exchanges, output: "c5" }),
    ).toThrow(/candidates/);
    expect(() =>
      buildFlow({ name: "Bad Name", pageUrl: "https://www.shop.example/", exchanges }),
    ).toThrow(/flow name/);
  });

  it("marks writes and reads the data a server-rendered page embeds", () => {
    const write = buildFlow({
      name: "cart",
      pageUrl: "https://x.example/",
      exchanges: [
        sanitizeExchange(
          exchange({
            id: "c1",
            method: "POST",
            url: "https://x.example/cart/add",
            postData: '{"sku":"a1"}',
            body: '{"cart":{"n":1}}',
          }),
        ),
      ],
    }).flow;
    expect(write.request.write).toBe(true);
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { list: [{ a: 1 }, { a: 2 }] } })}</script></html>`;
    expect(extractEmbeddedJson(html)).toEqual({ props: { list: [{ a: 1 }, { a: 2 }] } });
    const page = buildFlow({
      name: "page",
      pageUrl: "https://x.example/list",
      exchanges: [
        sanitizeExchange(
          exchange({
            id: "c1",
            kind: "document",
            url: "https://x.example/list?q=tea",
            contentType: "text/html",
            body: html,
          }),
        ),
      ],
      values: { q: "tea" },
    }).flow;
    expect(page.request.kind).toBe("html");
    expect(page.shape.items).toBe("props.list");
  });

  it("checks the recorded shape and names what is missing", () => {
    const shape = shapeOf(products);
    expect(checkShape(shape, products)).toEqual({ ok: true });
    expect(checkShape(shape, { ...products, results: [] })).toEqual({ ok: true });
    expect(checkShape(shape, { query: "", total: 0 })).toEqual({ ok: false, missing: "results" });
    expect(checkShape(shape, { ...products, results: [{ other: 1 }] })).toMatchObject({
      ok: false,
    });
  });

  it("returns only the records and fields asked for", () => {
    const shape = shapeOf(products);
    const picked = selectFlowData(shape, products, {
      where: { brand: "acme" },
      select: ["title", "price.amount"],
      limit: 1,
    });
    expect(picked).toEqual({
      data: [{ title: "Red runner", "price.amount": 40 }],
      total: 3,
      matched: 2,
      returned: 1,
      truncated: false,
    });
    const big = {
      results: Array.from({ length: 100 }, (_, i) => ({ id: i, text: "x".repeat(500) })),
    };
    const bounded = selectFlowData(shapeOf(big), big, { limit: 100 });
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded.data).length).toBeLessThanOrEqual(12_000);
  });

  it("classifies answers", () => {
    const { flow } = buildFlow({
      name: "search",
      pageUrl: "https://www.shop.example/",
      exchanges: recording(),
      values: { query: "red shoes" },
    });
    const classify = (status: number, body: string, retryAfter?: string) =>
      classifyFlowResponse({ flow, status, body, retryAfter }).kind;
    expect(classify(200, JSON.stringify(products))).toBe("ok");
    expect(classify(200, JSON.stringify({ moved: true }))).toBe("drift");
    expect(classify(429, "", "30")).toBe("rate_limited");
    expect(classify(403, "<title>Just a moment...</title>")).toBe("blocked");
    expect(classify(401, "")).toBe("auth");
    expect(classify(200, '<form><input type="password"></form>')).toBe("auth");
    expect(classify(200, "<html>hello</html>")).toBe("not_json");
    expect(classify(502, "")).toBe("server_error");
    expect(classify(404, "")).toBe("rejected");
  });
});

describe("saved flow review cases", () => {
  it("prefers the data request over a large page that embeds a little JSON-LD", () => {
    const page = `<html>${"x".repeat(200_000)}<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"name":"Home"}]}</script></html>`;
    const { flow } = buildFlow({
      name: "search",
      pageUrl: "https://www.shop.example/s?q=lamp",
      exchanges: [
        sanitizeExchange(
          exchange({
            id: "c1",
            kind: "document",
            url: "https://www.shop.example/s?q=lamp",
            contentType: "text/html",
            body: page,
          }),
        ),
        sanitizeExchange(
          exchange({
            id: "c2",
            url: "https://api.shop.example/search?q=lamp",
            body: JSON.stringify(products),
          }),
        ),
      ],
      values: { q: "lamp" },
    });
    expect(flow.request.url).toContain("api.shop.example/search");
  });

  it("counts opaque GraphQL operations and delete paths as writes, search bodies as reads", () => {
    const post = (url: string, postData: string) => ({ method: "POST", url, postData });
    expect(
      isWrite(
        post(
          "https://x.example/graphql",
          '{"operationName":"AddToCart","extensions":{"persistedQuery":{"sha256Hash":"a"}}}',
        ),
      ),
    ).toBe(true);
    expect(isWrite(post("https://x.example/api/graphql/", "doc_id=123&variables=%7B%7D"))).toBe(
      true,
    );
    expect(isWrite(post("https://x.example/api/list/delete", '{"id":1}'))).toBe(true);
    expect(isWrite(post("https://x.example/graphql", '{"query":"query Q { a }"}'))).toBe(false);
    expect(isWrite(post("https://x.example/api/search", '{"keyword":"lamp","page":1}'))).toBe(
      false,
    );
    expect(isWrite({ method: "GET", url: "https://x.example/account/logout" })).toBe(true);
    expect(isWrite(post("https://x.example/api/items", '{"query":"lamp"}'))).toBe(true);
    expect(isWrite(post("https://x.example/api/search", '{"query":"lamp"}'))).toBe(false);
    expect(
      isWrite(
        post(
          "https://x.example/gql",
          '{"query":"# add\\nfragment F on Cart { id }\\nmutation Add { add { ...F } }"}',
        ),
      ),
    ).toBe(true);
  });

  it("keeps no session fields from bodies, no Rails login, and only the referer's origin", () => {
    const form = sanitizeExchange(
      exchange({
        id: "c1",
        method: "POST",
        url: "https://x.example/api/search",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer: "https://x.example/s?q=private&u=7",
        },
        postData: "q=lamp&authenticity_token=SECRET&fb_dtsg=SECRET&pageToken=next",
      }),
    );
    expect(form.postData).toBe("q=lamp&pageToken=next");
    expect(form.session).toBe(true);
    expect(form.headers.referer).toBe("https://x.example/");
    const json = sanitizeExchange(
      exchange({
        id: "c2",
        method: "POST",
        url: "https://x.example/api/search",
        postData: '{"q":"lamp","meta":{"csrf_token":"SECRET"}}',
      }),
    );
    expect(JSON.parse(json.postData ?? "")).toEqual({ q: "lamp", meta: {} });
    for (const postData of ["user[password]=hunter2&user[email]=a", "user%5Bpassword%5D=hunter2"]) {
      expect(
        sanitizeExchange(
          exchange({ id: "c3", method: "POST", url: "https://x.example/session", postData }),
        ).skip,
      ).toBe("login");
    }
  });

  it("lets flow.output name an analytics-looking request the automatic pick skips", () => {
    const events = sanitizeExchange(
      exchange({
        id: "c9",
        url: "https://x.example/api/events?city=bcn",
        body: JSON.stringify({ events: [{ id: 1 }] }),
      }),
    );
    expect(() =>
      buildFlow({ name: "events", pageUrl: "https://x.example/", exchanges: [events] }),
    ).toThrow(/nothing to save/);
    expect(
      buildFlow({
        name: "events",
        pageUrl: "https://x.example/",
        exchanges: [events],
        output: "c9",
      }).flow.shape.items,
    ).toBe("events");
  });
});

describe("saved flow storage", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("writes, finds, lists and deletes flows per site, and ignores unknown files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "flows-"));
    roots.push(root);
    const { flow } = buildFlow({
      name: "search",
      pageUrl: "https://www.shop.example/",
      exchanges: recording(),
      values: { query: "red shoes" },
    });
    const file = await writeFlow(flow, root);
    expect(file).toBe(path.join(root, "shop.example", "search.json"));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await fs.writeFile(
      path.join(root, "shop.example", "odd.json"),
      JSON.stringify({ ...flow, name: "odd", cookie: "x" }),
    );
    expect((await listFlows("shop.example", root)).map((f) => f.name)).toEqual(["search"]);
    expect((await readFlow("search", undefined, root))?.site).toBe("shop.example");
    await writeFlow({ ...flow, site: "other.example" }, root);
    await expect(readFlow("search", undefined, root)).rejects.toThrow(/pass site/);
    expect(await deleteFlow("search", "shop.example", root)).toBe(true);
    expect(await readFlow("search", "shop.example", root)).toBeUndefined();
  });
});
