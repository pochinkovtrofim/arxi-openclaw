/** Read recent visits from an OpenClaw-managed Chromium profile. */
import path from "node:path";
import {
  openNodeSqliteDatabase,
  prepareSqliteReadOnlyLocationSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type { PwAiModule } from "./pw-ai-module.js";
import type { ProfileContext } from "./server-context.js";

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
  visitedAt: string | null;
};

type CdpNavigationEntry = { title?: unknown; url?: unknown };

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

function matchesHistoryQuery(entry: BrowserHistoryEntry, query: string | undefined): boolean {
  if (!query) {
    return true;
  }
  const needle = query.toLowerCase();
  return (
    entry.url.toLowerCase().includes(needle) || entry.title?.toLowerCase().includes(needle) === true
  );
}

function historyEntryKey(entry: BrowserHistoryEntry): string {
  return entry.url;
}

function normalizeLiveNavigation(entry: CdpNavigationEntry): BrowserHistoryEntry | null {
  if (typeof entry.url !== "string") {
    return null;
  }
  let protocol: string;
  try {
    protocol = new URL(entry.url).protocol;
  } catch {
    return null;
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return null;
  }
  return {
    title:
      typeof entry.title === "string"
        ? truncateHistoryText(entry.title, MAX_HISTORY_TITLE_LENGTH)
        : null,
    url: truncateHistoryText(entry.url, MAX_HISTORY_URL_LENGTH),
    visitedAt: null,
  };
}

/** Read unflushed navigation entries from running managed-browser tabs without mutating them. */
export async function readManagedChromeLiveHistory(params: {
  profileCtx: ProfileContext;
  pw: PwAiModule;
}): Promise<BrowserHistoryEntry[]> {
  const tabs = await params.profileCtx.listTabs();
  const histories = await Promise.allSettled(
    tabs.slice(0, MAX_HISTORY_LIMIT).map(async (tab) => {
      const page = await params.pw.getPageForTargetId({
        cdpUrl: params.profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
      });
      const result = (await params.pw.withPageScopedCdpClient({
        cdpUrl: params.profileCtx.profile.cdpUrl,
        page,
        targetId: tab.targetId,
        fn: async (send) => await send("Page.getNavigationHistory"),
      })) as { entries?: CdpNavigationEntry[] };
      if (!Array.isArray(result.entries)) {
        return [];
      }
      return result.entries
        .slice(-MAX_HISTORY_LIMIT)
        .toReversed()
        .flatMap((entry) => {
          const normalized = normalizeLiveNavigation(entry);
          return normalized ? [normalized] : [];
        });
    }),
  );
  if (!histories.some((result) => result.status === "fulfilled")) {
    const first = histories[0];
    if (first?.status === "rejected") {
      throw first.reason;
    }
  }
  return histories.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

/** Merge live, potentially unflushed navigations with the durable Chromium visit log. */
export function mergeManagedChromeHistory(params: {
  persisted: BrowserHistoryEntry[];
  live: BrowserHistoryEntry[];
  query?: string;
  limit?: number;
}): BrowserHistoryEntry[] {
  const query = normalizeHistoryQuery(params.query);
  const persisted = params.persisted.filter((entry) => matchesHistoryQuery(entry, query));
  const persistedByKey = new Map<string, BrowserHistoryEntry[]>();
  for (const entry of persisted) {
    const key = historyEntryKey(entry);
    const matches = persistedByKey.get(key);
    if (matches) {
      matches.push(entry);
    } else {
      persistedByKey.set(key, [entry]);
    }
  }
  const matchedPersisted = new Set<BrowserHistoryEntry>();
  const live = params.live
    .filter((entry) => matchesHistoryQuery(entry, query))
    .map((entry) => {
      const matched = persistedByKey.get(historyEntryKey(entry))?.shift();
      if (matched) {
        matchedPersisted.add(matched);
        return matched;
      }
      return entry;
    });
  return [...live, ...persisted.filter((entry) => !matchedPersisted.has(entry))].slice(
    0,
    normalizeHistoryLimit(params.limit),
  );
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
  const prepared = prepareSqliteReadOnlyLocationSync(
    path.join(params.userDataDir, "Default", "History"),
  );
  let database: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    database = openNodeSqliteDatabase(prepared.location, { readOnly: true });
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
    // SAFETY: the fixed SELECT list above defines this SQLite result shape.
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
    try {
      database?.close();
    } finally {
      prepared.cleanup();
    }
  }
}
