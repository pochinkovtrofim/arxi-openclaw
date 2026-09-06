import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readManagedChromeHistory } from "./chrome-history.js";

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
});
