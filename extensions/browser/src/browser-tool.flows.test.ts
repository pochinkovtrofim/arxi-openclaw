import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guarded = vi.hoisted(() => ({ fetchWithSsrFGuard: vi.fn() }));
const client = vi.hoisted(() => ({ browserFlowCapture: vi.fn(), browserFlowPageFetch: vi.fn() }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWithSsrFGuard: guarded.fetchWithSsrFGuard,
}));
vi.mock("./browser/client-actions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  browserFlowCapture: client.browserFlowCapture,
  browserFlowPageFetch: client.browserFlowPageFetch,
}));

const { executeFlowAction, savedFlowsHint, DEVICE_FETCH_URL } = await import("./browser-tool.flows.js");
const { readFlow } = await import("./browser/flows.js");

const products = { results: [{ id: 1, title: "Red runner" }, { id: 2, title: "Blue boot" }] };

function answer(status: number, body: unknown, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    response: new Response(text, { status, headers: { "content-type": contentType } }),
    finalUrl: "https://api.shop.example/",
    release: async () => {},
  };
}

function text(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function details(result: { details?: unknown }) {
  return result.details as Record<string, unknown>;
}

describe("browser saved flow actions", () => {
  let root: string;
  const context = () => ({ target: "http://127.0.0.1:18791", root, targetId: "tab-1" });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-actions-"));
    guarded.fetchWithSsrFGuard.mockReset();
    client.browserFlowCapture.mockReset();
    client.browserFlowPageFetch.mockReset();
    client.browserFlowCapture.mockResolvedValue({
      ok: true,
      targetId: "tab-1",
      pageUrl: "https://www.shop.example/s?q=red",
      exchanges: [
        {
          id: "c7",
          method: "GET",
          url: "https://api.shop.example/search?q=red",
          kind: "data",
          headers: { accept: "application/json" },
          session: true,
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(products),
        },
      ],
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("saves a flow from the tab and lists it on the site", async () => {
    const saved = details(await executeFlowAction("flow_save", { name: "search", params: { query: "red" } }, context()));
    expect(saved).toMatchObject({ ok: true, saved: "search", site: "shop.example", params: ["query"], request: "GET /search?q={{query|form}}" });
    const hint = await savedFlowsHint("https://shop.example/anything", root);
    expect(hint?.text).toContain("search(query)");
    expect(await savedFlowsHint("https://other.example/", root)).toBeUndefined();
    const listed = details(await executeFlowAction("flow_list", {}, context()));
    expect(listed.flows).toEqual([{ name: "search", site: "shop.example", params: ["query"], verified: true }]);
  });

  it("runs directly and returns only the asked fields", async () => {
    await executeFlowAction("flow_save", { name: "search", params: { query: "red" } }, context());
    guarded.fetchWithSsrFGuard.mockResolvedValue(answer(200, products));
    const result = await executeFlowAction(
      "flow_run",
      { name: "search", params: { query: "blue" }, where: { title: "boot" }, select: ["id"] },
      context(),
    );
    expect(guarded.fetchWithSsrFGuard.mock.calls[0][0].url).toBe("https://api.shop.example/search?q=blue");
    expect(details(result)).toMatchObject({ flow: "search", via: "http", verified: true });
    expect(text(result)).toContain('"id": 2');
    expect(text(result)).not.toContain("Red runner");
    expect(client.browserFlowPageFetch).not.toHaveBeenCalled();
  });

  it("falls back to the page when the direct request needs the session, and starts there next time", async () => {
    await executeFlowAction("flow_save", { name: "search", params: { query: "red" } }, context());
    guarded.fetchWithSsrFGuard.mockResolvedValue(answer(401, { error: "login" }));
    client.browserFlowPageFetch.mockResolvedValue({
      ok: true,
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(products),
      finalUrl: "https://api.shop.example/search?q=x",
    });
    const result = await executeFlowAction("flow_run", { name: "search", params: { query: "x" } }, context());
    expect(details(result)).toMatchObject({ via: "page" });
    expect((await readFlow("search", "shop.example", root))?.tier).toBe("page");
    await executeFlowAction("flow_run", { name: "search", params: { query: "y" } }, context());
    expect(guarded.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(client.browserFlowPageFetch).toHaveBeenCalledTimes(2);
  });

  it("marks a drifted flow unverified and says to use the page", async () => {
    await executeFlowAction("flow_save", { name: "search", params: { query: "red" } }, context());
    guarded.fetchWithSsrFGuard.mockResolvedValue(answer(200, { moved: true }));
    client.browserFlowPageFetch.mockResolvedValue({ ok: false, error: "not_on_site", pageUrl: "about:blank" });
    const result = details(await executeFlowAction("flow_run", { name: "search", params: { query: "x" } }, context()));
    expect(result).toMatchObject({ ok: false, verified: false });
    expect(String(result.hint)).toMatch(/site changed/);
    expect((await readFlow("search", "shop.example", root))?.drift).toBe("missing results");
  });

  it("refuses a write unless allowed, and sends it only once", async () => {
    client.browserFlowCapture.mockResolvedValue({
      ok: true,
      targetId: "tab-1",
      pageUrl: "https://www.shop.example/cart",
      exchanges: [
        {
          id: "c1",
          method: "POST",
          url: "https://www.shop.example/cart/add",
          kind: "data",
          headers: { "content-type": "application/json" },
          session: false,
          postData: '{"sku":"a1"}',
          status: 200,
          contentType: "application/json",
          body: '{"cart":{"items":1}}',
        },
      ],
    });
    await executeFlowAction("flow_save", { name: "add", params: { sku: "a1" } }, context());
    const refused = details(await executeFlowAction("flow_run", { name: "add", params: { sku: "b2" } }, context()));
    expect(refused.error).toBe("write_not_allowed");
    expect(guarded.fetchWithSsrFGuard).not.toHaveBeenCalled();
    guarded.fetchWithSsrFGuard.mockResolvedValue(answer(502, "bad gateway", "text/html"));
    const unknown = details(
      await executeFlowAction("flow_run", { name: "add", params: { sku: "b2" }, allowWrite: true }, context()),
    );
    expect(unknown.error).toBe("outcome_unknown");
    expect(guarded.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(client.browserFlowPageFetch).not.toHaveBeenCalled();
  });

  it("sends from the owner's computer only when asked", async () => {
    await executeFlowAction("flow_save", { name: "search", params: { query: "red" } }, context());
    const relay = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, status: 200, contentType: "application/json", body: JSON.stringify(products) })),
    );
    vi.stubGlobal("fetch", relay);
    const result = await executeFlowAction("flow_run", { name: "search", params: { query: "z" }, via: "device" }, context());
    expect(details(result)).toMatchObject({ via: "device" });
    expect(relay.mock.calls[0][0]).toBe(DEVICE_FETCH_URL);
    expect(JSON.parse(String((relay.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      url: "https://api.shop.example/search?q=z",
      method: "GET",
      write: false,
    });
    expect(guarded.fetchWithSsrFGuard).not.toHaveBeenCalled();
    relay.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const none = details(await executeFlowAction("flow_run", { name: "search", params: { query: "z" }, via: "device" }, context()));
    expect(none.error).toBe("device_unavailable");
  });

  it("reports what the tab had when there is nothing to save", async () => {
    client.browserFlowCapture.mockResolvedValue({ ok: true, targetId: "tab-1", pageUrl: "https://x.example/", exchanges: [] });
    const result = details(await executeFlowAction("flow_save", { name: "nothing" }, context()));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/nothing to save/);
  });
});
