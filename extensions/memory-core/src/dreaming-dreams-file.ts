// Memory Core helpers for safe managed DREAMS.md updates.
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryArtifactSourceRef } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { replaceManagedMarkdownBlock } from "openclaw/plugin-sdk/memory-host-markdown";
import { readRegularFile, replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { readDreamingSource, commitDreamingSourceWrite } from "./dreaming-source-lineage.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { filterLiveShortTermRecallEntries } from "./short-term-promotion-record.js";
import { readStore } from "./short-term-promotion-store.js";

export const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
const DEEP_START_MARKER = "<!-- openclaw:dreaming:deep:start -->";
const DEEP_END_MARKER = "<!-- openclaw:dreaming:deep:end -->";

async function resolveDreamsPath(workspaceDir: string): Promise<string> {
  for (const name of DREAMS_FILENAMES) {
    const target = path.join(workspaceDir, name);
    try {
      await fs.access(target);
      return target;
    } catch (err) {
      if (extractErrorCode(err) !== "ENOENT") {
        throw err;
      }
    }
  }
  return path.join(workspaceDir, DREAMS_FILENAMES[0]);
}

function isEmptyDreamsReadError(err: unknown, code: string | undefined): boolean {
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "not-found" ||
    code === "not-file" ||
    code === "path-alias" ||
    code === "path-mismatch" ||
    code === "symlink"
  ) {
    return true;
  }
  return err instanceof Error && err.message === "path must be a regular file";
}

export async function readDreamsFile(dreamsPath: string): Promise<string> {
  try {
    return (await readRegularFile({ filePath: dreamsPath })).buffer.toString("utf-8");
  } catch (err) {
    if (isEmptyDreamsReadError(err, extractErrorCode(err))) {
      return "";
    }
    throw err;
  }
}

async function assertSafeDreamsPath(dreamsPath: string): Promise<void> {
  const stat = await fs.lstat(dreamsPath).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!stat) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error("Refusing to write symlinked DREAMS.md");
  }
  if (!stat.isFile()) {
    throw new Error("Refusing to write non-file DREAMS.md");
  }
}

async function writeDreamsFileAtomic(dreamsPath: string, content: string): Promise<void> {
  await assertSafeDreamsPath(dreamsPath);
  await replaceFileAtomic({
    filePath: dreamsPath,
    content,
    mode: 0o600,
    preserveExistingMode: true,
    tempPrefix: `${path.basename(dreamsPath)}.dreams`,
    throwOnCleanupError: true,
  });
}

export async function updateDreamsFile<T>(params: {
  workspaceDir: string;
  sourceRefs?: readonly MemoryArtifactSourceRef[];
  updater: (
    existing: string,
    dreamsPath: string,
  ) =>
    | Promise<{
        content: string;
        result: T;
        shouldWrite?: boolean;
        sourceRefs?: readonly MemoryArtifactSourceRef[];
      }>
    | {
        content: string;
        result: T;
        shouldWrite?: boolean;
        sourceRefs?: readonly MemoryArtifactSourceRef[];
      };
}): Promise<T> {
  // Read and replace under the purge owner's lock so an awaited diary update
  // cannot write a pre-deletion file snapshot back over the scrubbed contents.
  return await withMemoryWorkspaceLock(params.workspaceDir, async () => {
    const dreamsPath = await resolveDreamsPath(params.workspaceDir);
    const existing = await readDreamsFile(dreamsPath);
    const {
      content,
      result,
      shouldWrite = true,
      sourceRefs = params.sourceRefs,
    } = await params.updater(existing, dreamsPath);
    if (shouldWrite) {
      await fs.mkdir(path.dirname(dreamsPath), { recursive: true });
      const after = content.endsWith("\n") ? content : `${content}\n`;
      await commitDreamingSourceWrite({
        workspaceDir: params.workspaceDir,
        filePath: dreamsPath,
        before: existing,
        after,
        refs: sourceRefs,
        commit: () => writeDreamsFileAtomic(dreamsPath, after),
      });
    }
    return result;
  });
}

export async function updateDeepDreamsFile(params: {
  workspaceDir: string;
  bodyLines: string[];
}): Promise<string> {
  const body = params.bodyLines.join("\n");
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => ({
      content: replaceManagedMarkdownBlock({
        original: existing,
        heading: "## Deep Sleep",
        startMarker: DEEP_START_MARKER,
        endMarker: DEEP_END_MARKER,
        body,
      }),
      result: dreamsPath,
      shouldWrite: params.bodyLines.length > 0,
    }),
  });
}

const DIARY_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
const DIARY_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";
const BACKFILL_ENTRY_MARKER = "openclaw:dreaming:backfill-entry";
const RECENT_DIARY_CONTEXT_LIMIT = 3;
const RECENT_DIARY_CONTEXT_MAX_CHARS = 360;

// ── Date formatting ────────────────────────────────────────────────────

function formatNarrativeDate(epochMs: number, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: timezone ?? process.env.TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    // Always include the timezone abbreviation so the reader knows which
    // timezone the timestamp refers to.  Without this, users who haven't
    // configured a timezone see bare times that look local but are actually
    // UTC, causing confusion (see #65027).
    timeZoneName: "short",
  };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}

// ── DREAMS.md file I/O ─────────────────────────────────────────────────

function ensureDiarySection(existing: string): string {
  if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) {
    return existing;
  }
  const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}\n${DIARY_END_MARKER}\n`;
  if (existing.trim().length === 0) {
    return diarySection;
  }
  return diarySection + "\n" + existing;
}

function replaceDiaryContent(existing: string, diaryContent: string): string {
  const ensured = ensureDiarySection(existing);
  const startIdx = ensured.indexOf(DIARY_START_MARKER);
  const endIdx = ensured.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return ensured;
  }
  const before = ensured.slice(0, startIdx + DIARY_START_MARKER.length);
  const after = ensured.slice(endIdx);
  const normalized = diaryContent.trim().length > 0 ? `\n${diaryContent.trim()}\n` : "\n";
  return before + normalized + after;
}

function splitDiaryBlocks(diaryContent: string): string[] {
  return diaryContent
    .split(/\n---\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

export function clampDreamDiaryContextEntry(entry: string): string {
  const normalized = entry.replace(/\s+/g, " ").trim();
  if (normalized.length <= RECENT_DIARY_CONTEXT_MAX_CHARS) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, RECENT_DIARY_CONTEXT_MAX_CHARS).trimEnd()}...`;
}

function normalizeDiaryBlockBody(block: string): string {
  const bodyLines: string[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--") || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("*") && trimmed.endsWith("*") && trimmed.length > 2) {
      continue;
    }
    bodyLines.push(trimmed);
  }
  return clampDreamDiaryContextEntry(bodyLines.join(" "));
}

function isOptionalDiaryContextReadError(err: unknown): boolean {
  const code = extractErrorCode(err);
  // Optional prompt context may omit unreadable diaries; updates must preserve the failure.
  return code === "EACCES" || code === "EPERM" || isEmptyDreamsReadError(err, code);
}

function getDiaryContextEntries(existing: string): string[] {
  const startIdx = existing.indexOf(DIARY_START_MARKER);
  const endIdx = existing.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return [];
  }
  const inner = existing.slice(startIdx + DIARY_START_MARKER.length, endIdx);
  return splitDiaryBlocks(inner)
    .map(normalizeDiaryBlockBody)
    .filter((entry) => entry.length > 0);
}

export async function readRecentDreamDiaryEntries(params: {
  workspaceDir: string;
  limit?: number;
}): Promise<string[]> {
  const limit = Math.max(0, Math.floor(params.limit ?? RECENT_DIARY_CONTEXT_LIMIT));
  if (limit === 0) {
    return [];
  }
  let existing: string;
  try {
    const dreamsPath = await resolveDreamsPath(params.workspaceDir);
    existing = (
      await readDreamingSource(params.workspaceDir, dreamsPath, await readDreamsFile(dreamsPath))
    ).content;
  } catch (err) {
    if (isOptionalDiaryContextReadError(err)) {
      return [];
    }
    throw err;
  }
  return getDiaryContextEntries(existing).slice(-limit).toReversed();
}

/** Revalidate the actual selected entries and diary quotes, never infer source identities. */
export async function readDreamNarrativeSources(params: {
  workspaceDir: string;
  sourceEntryKeys?: readonly string[];
  recentDiaryEntries?: readonly string[];
  entrySourceRefs?: readonly MemoryArtifactSourceRef[];
  snippets?: readonly string[];
}) {
  const keys = params.sourceEntryKeys ?? [];
  const store = keys.length
    ? (await readStore(params.workspaceDir, new Date().toISOString())).entries
    : {};
  const live = await filterLiveShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    requireCurrentSource: true,
    entries: keys.flatMap((key) => (store[key] ? [store[key]] : [])),
  });
  const liveKeys = new Set(live.map((entry) => entry.key));
  if (keys.some((key) => !liveKeys.has(key))) {
    return { current: false, sourceRefs: [] };
  }
  const refs = live.flatMap((entry) => entry.sourceRefs ?? []);
  // For source-bound phase inputs, changed cached text cannot borrow the new
  // file's authority merely because its recall key still exists.
  if (
    refs.length &&
    params.snippets?.some((snippet) => !live.some((entry) => entry.snippet === snippet))
  ) {
    return { current: false, sourceRefs: [] };
  }
  if (params.recentDiaryEntries?.length) {
    const file = await resolveDreamsPath(params.workspaceDir);
    const source = await readDreamingSource(params.workspaceDir, file, await readDreamsFile(file));
    const blocks = new Set(getDiaryContextEntries(source.content));
    if (
      params.recentDiaryEntries.some((block) => !blocks.has(clampDreamDiaryContextEntry(block)))
    ) {
      return { current: false, sourceRefs: [] };
    }
    refs.push(...source.refsForRange());
  }
  const sourceRefs = [
    ...new Map(refs.map((ref) => [JSON.stringify([ref.ownerId, ref.value]), ref])).values(),
  ];
  if (params.entrySourceRefs) {
    const key = (ref: MemoryArtifactSourceRef) => JSON.stringify([ref.ownerId, ref.value]);
    // Diary context adds its own dependencies after the phase captured refs.
    const currentEntryRefs = [
      ...new Set(live.flatMap((entry) => entry.sourceRefs ?? []).map(key)),
    ].toSorted();
    if (
      JSON.stringify([...new Set(params.entrySourceRefs.map(key))].toSorted()) !==
      JSON.stringify(currentEntryRefs)
    ) {
      return { current: false, sourceRefs: [] };
    }
  }
  return { current: true, sourceRefs };
}

function normalizeDiaryBlockFingerprint(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let dateLine = "";
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (!dateLine && line.startsWith("*") && line.endsWith("*") && line.length > 2) {
      dateLine = line.slice(1, -1).trim();
      continue;
    }
    if (line.startsWith("<!--") || line.startsWith("#")) {
      continue;
    }
    bodyLines.push(line);
  }
  const normalizedDate = dateLine.replace(/\s+/g, " ").trim();
  const normalizedBody = bodyLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return `${normalizedDate}\n${normalizedBody}`;
}

function joinDiaryBlocks(blocks: string[]): string {
  if (blocks.length === 0) {
    return "";
  }
  return blocks.map((block) => `---\n\n${block.trim()}\n`).join("\n");
}

function stripBackfillDiaryBlocks(existing: string): { updated: string; removed: number } {
  const ensured = ensureDiarySection(existing);
  const startIdx = ensured.indexOf(DIARY_START_MARKER);
  const endIdx = ensured.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return { updated: ensured, removed: 0 };
  }
  const inner = ensured.slice(startIdx + DIARY_START_MARKER.length, endIdx);
  const kept: string[] = [];
  let removed = 0;
  for (const block of splitDiaryBlocks(inner)) {
    if (block.includes(BACKFILL_ENTRY_MARKER)) {
      removed += 1;
      continue;
    }
    kept.push(block);
  }
  return {
    updated: replaceDiaryContent(ensured, joinDiaryBlocks(kept)),
    removed,
  };
}

function formatBackfillDiaryDate(isoDay: string, _timezone?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) {
    return isoDay;
  }
  const [, year, month, day] = match;
  const opts: Intl.DateTimeFormatOptions = {
    // Preserve the source iso day exactly; backfill labels should not drift by timezone.
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  const epochMs = Date.UTC(Number(year), Number(month) - 1, Number(day), 12);
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}

function buildBackfillDiaryEntry(params: {
  isoDay: string;
  bodyLines: string[];
  sourcePath?: string;
  timezone?: string;
}): string {
  const dateStr = formatBackfillDiaryDate(params.isoDay, params.timezone);
  const marker = `<!-- ${BACKFILL_ENTRY_MARKER} day=${params.isoDay}${params.sourcePath ? ` source=${params.sourcePath}` : ""} -->`;
  const body = params.bodyLines
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return [`*${dateStr}*`, marker, body].filter((part) => part.length > 0).join("\n\n");
}

export async function writeBackfillDiaryEntries(params: {
  workspaceDir: string;
  entries: Array<{
    isoDay: string;
    bodyLines: string[];
    sourcePath?: string;
  }>;
  preserveExisting?: boolean;
  sourceRefs?: readonly MemoryArtifactSourceRef[];
  timezone?: string;
}): Promise<{ dreamsPath: string; written: number; replaced: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    sourceRefs: params.sourceRefs,
    updater: (existing, dreamsPath) => {
      const stripped = params.preserveExisting
        ? { updated: existing, removed: 0 }
        : stripBackfillDiaryBlocks(existing);
      const startIdx = stripped.updated.indexOf(DIARY_START_MARKER);
      const endIdx = stripped.updated.indexOf(DIARY_END_MARKER);
      const inner =
        startIdx >= 0 && endIdx > startIdx
          ? stripped.updated.slice(startIdx + DIARY_START_MARKER.length, endIdx)
          : "";
      const preservedBlocks = splitDiaryBlocks(inner);
      const additions = params.entries.map((entry) =>
        buildBackfillDiaryEntry({
          isoDay: entry.isoDay,
          bodyLines: entry.bodyLines,
          sourcePath: entry.sourcePath,
          timezone: params.timezone,
        }),
      );
      const existingFingerprints = new Set(
        preservedBlocks.map((block) => normalizeDiaryBlockFingerprint(block)),
      );
      const appended = params.preserveExisting
        ? additions.filter((block) => {
            const fingerprint = normalizeDiaryBlockFingerprint(block);
            if (existingFingerprints.has(fingerprint)) {
              return false;
            }
            existingFingerprints.add(fingerprint);
            return true;
          })
        : additions;
      const nextBlocks = [...preservedBlocks, ...appended];
      return {
        content: replaceDiaryContent(stripped.updated, joinDiaryBlocks(nextBlocks)),
        result: {
          dreamsPath,
          written: appended.length,
          replaced: stripped.removed,
        },
      };
    },
  });
}

export async function removeBackfillDiaryEntries(params: {
  workspaceDir: string;
}): Promise<{ dreamsPath: string; removed: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const stripped = stripBackfillDiaryBlocks(existing);
      return {
        content: stripped.updated,
        result: {
          dreamsPath,
          removed: stripped.removed,
        },
        shouldWrite: stripped.removed > 0 || existing.length > 0,
      };
    },
  });
}

export async function dedupeDreamDiaryEntries(params: {
  workspaceDir: string;
}): Promise<{ dreamsPath: string; removed: number; kept: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const ensured = ensureDiarySection(existing);
      const startIdx = ensured.indexOf(DIARY_START_MARKER);
      const endIdx = ensured.indexOf(DIARY_END_MARKER);
      if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
        return {
          content: ensured,
          result: { dreamsPath, removed: 0, kept: 0 },
          shouldWrite: false,
        };
      }
      const inner = ensured.slice(startIdx + DIARY_START_MARKER.length, endIdx);
      const blocks = splitDiaryBlocks(inner);
      const seen = new Set<string>();
      const keptBlocks: string[] = [];
      let removed = 0;
      for (const block of blocks) {
        const fingerprint = normalizeDiaryBlockFingerprint(block);
        if (seen.has(fingerprint)) {
          removed += 1;
          continue;
        }
        seen.add(fingerprint);
        keptBlocks.push(block);
      }
      return {
        content: replaceDiaryContent(ensured, joinDiaryBlocks(keptBlocks)),
        result: {
          dreamsPath,
          removed,
          kept: keptBlocks.length,
        },
        shouldWrite: removed > 0,
      };
    },
  });
}

function buildDiaryEntry(narrative: string, dateStr: string): string {
  return `\n---\n\n*${dateStr}*\n\n${narrative}\n`;
}

export async function appendNarrativeEntry(params: {
  workspaceDir: string;
  narrative: string;
  nowMs: number;
  timezone?: string;
  sourceEntryKeys?: readonly string[];
  recentDiaryEntries?: readonly string[];
  sourceRefs?: readonly MemoryArtifactSourceRef[];
  sourceSnippets?: readonly string[];
}): Promise<string | undefined> {
  const dateStr = formatNarrativeDate(params.nowMs, params.timezone);
  const entry = buildDiaryEntry(params.narrative, dateStr);
  return await updateDreamsFile<string | undefined>({
    workspaceDir: params.workspaceDir,
    sourceRefs: params.sourceRefs,
    updater: async (existing, dreamsPath) => {
      const sources = await readDreamNarrativeSources({
        ...params,
        snippets: params.sourceSnippets,
      });
      const identity = (refs: readonly MemoryArtifactSourceRef[]) =>
        JSON.stringify(refs.map((ref) => JSON.stringify([ref.ownerId, ref.value])).toSorted());
      // Model work ran outside the purge lock. The selected source set must
      // remain current and exact, rather than blessing new refs after a change.
      if (
        !sources.current ||
        (params.sourceRefs && identity(params.sourceRefs) !== identity(sources.sourceRefs))
      ) {
        return { content: existing, result: undefined, shouldWrite: false };
      }
      let updated: string;
      if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) {
        const endIdx = existing.lastIndexOf(DIARY_END_MARKER);
        updated = existing.slice(0, endIdx) + entry + "\n" + existing.slice(endIdx);
      } else if (existing.includes(DIARY_START_MARKER)) {
        const startIdx = existing.indexOf(DIARY_START_MARKER) + DIARY_START_MARKER.length;
        updated =
          existing.slice(0, startIdx) +
          entry +
          "\n" +
          DIARY_END_MARKER +
          "\n" +
          existing.slice(startIdx);
      } else {
        const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}${entry}\n${DIARY_END_MARKER}\n`;
        updated = existing.trim().length === 0 ? diarySection : `${diarySection}\n${existing}`;
      }
      return { content: updated, result: dreamsPath, sourceRefs: sources.sourceRefs };
    },
  });
}
