import path from "node:path";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { SESSION_ARCHIVE_ZSTD_SUFFIX } from "../config/sessions/archive-compression.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import { encodeArchiveContent } from "./state-migrations.transcript-directives-archives.js";
import { decodeUtf8Input } from "./utf8-input.js";
import { resolveZstdCodec } from "./zstd-codec.js";

const ARCHIVE_TEMP_MARKER = ".media-retirement";

function archiveSourceMatches(
  filePath: string,
  expected: ReturnType<typeof readRegularFileSync>,
): boolean {
  try {
    const current = readRegularFileSync({ filePath });
    return (
      current.exactIdentity.dev === expected.exactIdentity.dev &&
      current.exactIdentity.ino === expected.exactIdentity.ino &&
      current.stat.mtimeMs === expected.stat.mtimeMs &&
      current.stat.size === expected.stat.size &&
      current.buffer.equals(expected.buffer)
    );
  } catch {
    return false;
  }
}

/** Rewrites one transcript archive's legacy media fields in place; false when unchanged. */
export function migrateTranscriptArchive(
  filePath: string,
  options: { beforeReplace?: () => void } = {},
): boolean {
  const source = readRegularFileSync({ filePath });
  const compressed = filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
  const codec = compressed ? resolveZstdCodec() : null;
  if (compressed && !codec) {
    throw new Error("Cannot decode compressed transcript archive: this runtime lacks zstd support");
  }
  const content = decodeUtf8Input(
    codec ? codec.decompress(source.buffer) : source.buffer,
    filePath,
  );
  const transformed = transformMediaArchiveContent(content, filePath);
  if (!transformed.changed) {
    return false;
  }
  const encoded = encodeArchiveContent(
    transformed.content,
    compressed ? "zstd" : "identity",
    filePath,
  );
  options.beforeReplace?.();
  replaceFileAtomicSync({
    filePath,
    content: encoded,
    preserveExistingMode: true,
    syncParentDir: true,
    syncTempFile: true,
    tempPrefix: `${path.basename(filePath)}${ARCHIVE_TEMP_MARKER}`,
    beforeRename: () => {
      if (!archiveSourceMatches(filePath, source)) {
        throw new Error(`${filePath} changed before atomic media migration replacement`);
      }
    },
  });
  return true;
}

/** Doctor-only migration from top-level Media* transcript fields to canonical facts. */