// Browser tests cover the managed-history route's live/durable source boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const historyMocks = vi.hoisted(() => ({
  readPersisted: vi.fn(),
  readLive: vi.fn(),
}));

vi.mock("../chrome-history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chrome-history.js")>();
  return {
    ...actual,
    readManagedChromeHistory: historyMocks.readPersisted,
    readManagedChromeLiveHistory: historyMocks.readLive,
  };
});
vi.mock("../chrome.js", () => ({ resolveOpenClawUserDataDir: () => "/managed-profile" }));
vi.mock("../profile-capabilities.js", () => ({
  getBrowserProfileCapabilities: () => ({
    mode: "local-managed",
    browserFilesystemLocal: true,
  }),
}));
vi.mock("../pw-ai-module.js", () => ({ getPwAiModule: async () => ({}) }));

const { registerBrowserHistoryRoutes } = await import("./history.js");

async function callHistoryRoute() {
  const stop = vi.fn();
  const profileCtx = {
    profile: { name: "openclaw", cdpUrl: "http://127.0.0.1:9222" },
    stopRunningBrowser: stop,
  };
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserHistoryRoutes(app, { forProfile: () => profileCtx } as never);
  const response = createBrowserRouteResponse();
  await getHandlers.get("/history")?.(
    { params: {}, body: {}, query: { query: "history-live", limit: "2" } },
    response.res,
  );
  return { response, stop };
}

describe("browser history route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns live navigations when Chromium has not flushed its History database", async () => {
    historyMocks.readPersisted.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    historyMocks.readLive.mockResolvedValueOnce([
      {
        title: "Second page",
        url: "https://example.org/?arxi_probe=history-live",
        visitedAt: null,
      },
      {
        title: "First page",
        url: "https://example.com/?arxi_probe=history-live",
        visitedAt: null,
      },
    ]);

    const { response, stop } = await callHistoryRoute();

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ entries: [{ visitedAt: null }, { visitedAt: null }] });
    expect(stop).not.toHaveBeenCalled();
  });

  it("returns durable visits when live tab inspection fails", async () => {
    historyMocks.readPersisted.mockReturnValueOnce([
      {
        title: "Durable page",
        url: "https://example.com/?arxi_probe=history-live",
        visitedAt: "2026-09-11T00:00:00.000Z",
      },
    ]);
    historyMocks.readLive.mockRejectedValueOnce(new Error("browser stopped"));

    const { response, stop } = await callHistoryRoute();

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      entries: [{ title: "Durable page", visitedAt: "2026-09-11T00:00:00.000Z" }],
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("reports unavailable history only when both sources fail", async () => {
    historyMocks.readPersisted.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    historyMocks.readLive.mockRejectedValueOnce(new Error("browser stopped"));

    const { response, stop } = await callHistoryRoute();

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error:
        "browser history is unavailable; start the managed browser and browse a page before retrying",
    });
    expect(stop).not.toHaveBeenCalled();
  });
});
