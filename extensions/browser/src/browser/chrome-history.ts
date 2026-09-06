/** Read recent visits from an OpenClaw-managed Chromium profile. */
import path from "node:path";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";

const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const MAX_HISTORY_QUERY_LENGTH = 256;
const MAX_HISTORY_TITLE_LENGTH = 256;
const MAX_HISTORY_URL_LENGTH = 2048;

type ChromeHistoryRow = {
  title: string | null;
  url: string;
  visit_time: number | bigint;
};

export type BrowserHistoryEntry = {
  title: string | null;
  url: string;
  visitedAt: string;
};

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(Math.max(1, Math.trunc(value)), MAX_HISTORY_LIMIT);
}

function normalizeHistoryQuery(value: string | undefined): string | undefined {
  const query = value?.trim();
  if (!query) {
    return undefined;
  }
  return query.slice(0, MAX_HISTORY_QUERY_LENGTH);
}

function escapeSqliteLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function truncateHistoryText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  let end = maxLength - 1;
  const lastIncluded = value.charCodeAt(end - 1);
  const firstExcluded = value.charCodeAt(end);
  if (
    lastIncluded >= 0xd800 &&
    lastIncluded <= 0xdbff &&
    firstExcluded >= 0xdc00 &&
    firstExcluded <= 0xdfff
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function chromeVisitTimeToIso(value: number | bigint): string | null {
  const micros = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  const milliseconds = micros / 1_000n - BigInt(CHROME_EPOCH_OFFSET_MS);
  const timestamp = Number(milliseconds);
  if (!Number.isSafeInteger(timestamp)) {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/** Read bounded visit metadata without exposing Chromium cookie or storage records. */
export function readManagedChromeHistory(params: {
  userDataDir: string;
  query?: string;
  limit?: number;
}): BrowserHistoryEntry[] {
  const database = openNodeSqliteDatabase(path.join(params.userDataDir, "Default", "History"), {
    readOnly: true,
  });
  try {
    const query = normalizeHistoryQuery(params.query);
    const where = query ? "WHERE urls.url LIKE ? ESCAPE '\\' OR urls.title LIKE ? ESCAPE '\\'" : "";
    const statement = database.prepare(`
      SELECT urls.title, urls.url, visits.visit_time
      FROM visits
      JOIN urls ON urls.id = visits.url
      ${where}
      ORDER BY visits.visit_time DESC
      LIMIT ?
    `);
    statement.setReadBigInts(true);
    const bindings = query
      ? [
          `%${escapeSqliteLike(query)}%`,
          `%${escapeSqliteLike(query)}%`,
          normalizeHistoryLimit(params.limit),
        ]
      : [normalizeHistoryLimit(params.limit)];
    const rows = statement.all(...bindings) as unknown as ChromeHistoryRow[];
    return rows.flatMap((row) => {
      const visitedAt = chromeVisitTimeToIso(row.visit_time);
      return visitedAt
        ? [
            {
              title:
                row.title === null
                  ? null
                  : truncateHistoryText(row.title, MAX_HISTORY_TITLE_LENGTH),
              url: truncateHistoryText(row.url, MAX_HISTORY_URL_LENGTH),
              visitedAt,
            },
          ]
        : [];
    });
  } finally {
    database.close();
  }
}
