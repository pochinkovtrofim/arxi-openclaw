import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeManagedChromeHistory,
  readManagedChromeHistory,
  readManagedChromeLiveHistory,
} from "./chrome-history.js";
import type { PwAiModule } from "./pw-ai-module.js";
import type { ProfileContext } from "./server-context.js";

const tempDirs: string[] = [];

async function createHistoryDatabase() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-history-"));
  tempDirs.push(userDataDir);
  const profileDir = path.join(userDataDir, "Default");
  await fs.mkdir(profileDir);
  const database = new DatabaseSync(path.join(profileDir, "History"));
  database.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL);
    INSERT INTO urls (id, url, title) VALUES
      (1, 'https://example.com/old', 'Old example'),
      (2, 'https://example.com/report_2026', 'Quarterly report');
    INSERT INTO visits (id, url, visit_time) VALUES
      (1, 1, 13253760000000000),
      (2, 2, 13253760001000000);
  `);
  database.close();
  return userDataDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true })));
});

describe("readManagedChromeHistory", () => {
  it("returns bounded visit metadata in newest-first order", async () => {
    const userDataDir = await createHistoryDatabase();

    expect(readManagedChromeHistory({ userDataDir, limit: 1 })).toEqual([
      {
        title: "Quarterly report",
        url: "https://example.com/report_2026",
        visitedAt: "2020-12-30T00:00:01.000Z",
      },
    ]);
  });

  it("keeps live navigations from healthy tabs when another tab closes", async () => {
    const page = {};
    const send = vi.fn(async () => ({
      entries: [
        { title: "", url: "about:blank" },
        { title: "First page", url: "https://example.com/?arxi_probe=history-live" },
        { title: "Second page", url: "https://example.org/?arxi_probe=history-live" },
      ],
    }));
    const pw = {
      getPageForTargetId: vi.fn(async ({ targetId }) => {
        if (targetId === "closed-tab") {
          throw new Error("tab closed during history read");
        }
        return page;
      }),
      withPageScopedCdpClient: vi.fn(async ({ fn }) => await fn(send)),
    } as unknown as PwAiModule;
    const profileCtx = {
      profile: { cdpUrl: "http://127.0.0.1:9222" },
      listTabs: vi.fn(async () => [{ targetId: "tab-1" }, { targetId: "closed-tab" }]),
    } as unknown as ProfileContext;

    await expect(readManagedChromeLiveHistory({ profileCtx, pw })).resolves.toEqual([
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
    expect(send).toHaveBeenCalledWith("Page.getNavigationHistory");
    expect(pw.getPageForTargetId).toHaveBeenCalledTimes(2);
  });

  it("merges live and durable visits without duplicating flushed navigations", () => {
    expect(
      mergeManagedChromeHistory({
        query: "report_",
        limit: 2,
        live: [
          {
            title: "Current report (live)",
            url: "https://example.com/report_2026",
            visitedAt: null,
          },
        ],
        persisted: [
          {
            title: "Current report",
            url: "https://example.com/report_2026",
            visitedAt: "2026-09-11T00:00:00.000Z",
          },
          {
            title: "Earlier report",
            url: "https://example.com/report_2025",
            visitedAt: "2025-09-11T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual([
      {
        title: "Current report",
        url: "https://example.com/report_2026",
        visitedAt: "2026-09-11T00:00:00.000Z",
      },
      {
        title: "Earlier report",
        url: "https://example.com/report_2025",
        visitedAt: "2025-09-11T00:00:00.000Z",
      },
    ]);
  });

  it("reads history while Chromium-style exclusive locking remains active", async () => {
    const userDataDir = await createHistoryDatabase();
    const historyPath = path.join(userDataDir, "Default", "History");
    const chromium = new DatabaseSync(historyPath);
    chromium.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");

    try {
      expect(readManagedChromeHistory({ userDataDir, query: "report_" })).toEqual([
        {
          title: "Quarterly report",
          url: "https://example.com/report_2026",
          visitedAt: "2020-12-30T00:00:01.000Z",
        },
      ]);
    } finally {
      chromium.close();
    }
  });

  it("searches titles and URLs literally without exposing other records", async () => {
    const userDataDir = await createHistoryDatabase();

    expect(readManagedChromeHistory({ userDataDir, query: "report_" })).toEqual([
      {
        title: "Quarterly report",
        url: "https://example.com/report_2026",
        visitedAt: "2020-12-30T00:00:01.000Z",
      },
    ]);
  });

  it("bounds long titles and URLs before returning them to the caller", async () => {
    const userDataDir = await createHistoryDatabase();
    const database = new DatabaseSync(path.join(userDataDir, "Default", "History"));
    database
      .prepare("UPDATE urls SET title = ?, url = ? WHERE id = 2")
      .run("t".repeat(300), `https://example.com/${"u".repeat(2100)}`);
    database.close();

    const [entry] = readManagedChromeHistory({ userDataDir, limit: 1 });

    expect(entry?.title).toHaveLength(256);
    expect(entry?.title).toMatch(/…$/u);
    expect(entry?.url).toHaveLength(2048);
    expect(entry?.url).toMatch(/…$/u);
  });

  it("preserves empty titles and valid Unicode when bounding history metadata", async () => {
    const userDataDir = await createHistoryDatabase();
    const database = new DatabaseSync(path.join(userDataDir, "Default", "History"));
    database
      .prepare("UPDATE urls SET title = ?, url = ? WHERE id = 2")
      .run(`${"t".repeat(254)}😀x`, "https://example.com/empty-title");
    database.close();

    const [unicodeEntry] = readManagedChromeHistory({ userDataDir, limit: 1 });
    expect(unicodeEntry?.title).toBe(`${"t".repeat(254)}…`);

    const emptyTitleDatabase = new DatabaseSync(path.join(userDataDir, "Default", "History"));
    emptyTitleDatabase.prepare("UPDATE urls SET title = '' WHERE id = 2").run();
    emptyTitleDatabase.close();

    const [emptyTitleEntry] = readManagedChromeHistory({ userDataDir, limit: 1 });
    expect(emptyTitleEntry?.title).toBe("");
  });
});
