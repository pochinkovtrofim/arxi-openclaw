#!/usr/bin/env node
// Fingerprints the source that defines persisted state formats and their repair.
//
// Arxi runs `doctor --fix` and a memory index offline on an owner's first wake
// after an OpenClaw change. Two builds with the same fingerprint carry the same
// migrations, schema versions and doctor repairs, so state that one build's
// doctor completed needs nothing from the other's and that wake can skip it.
// The set is deliberately broad: a file that only looks related costs one
// unnecessary repair, while a missed migration would skip a needed one.
//
// Doctor reaches plugin repairs through runtime facades that no import graph
// shows, so whole persisted-state owners join by directory (the memory plugin,
// plugin state) and repairs by name; the modules doctor imports directly join
// as its callees. Following imports further would take in most of the runtime.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const EXACT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "scripts/arxi-state-format.mjs",
  "src/cli/program/register.maintenance.ts",
]);
const TREES = [
  "src/state/",
  "src/config/sessions/",
  "src/memory/",
  "src/memory-host-sdk/",
  "src/plugin-state/",
  "packages/memory-host-sdk/src/host/",
  "extensions/memory-core/src/",
];
const PREFIXES = /^src\/infra\/(?:sqlite|state-)|^src\/plugin-sdk\/[^/]*memory/u;
const NAMED = /doctor|migrat|legacy|repair|normaliz/iu;
const NAMED_DIRS = new Set(["doctor", "migrate", "migration", "migrations", "legacy"]);
const CODE = /\.(?:[cm]?[jt]s)$/u;
// A persisted-format version anywhere in the tree joins the set by content.
const FORMAT_VERSION =
  /\bconst\s+[A-Z0-9_]*(?:SCHEMA|FORMAT|STORE|STATE|CHUNKING|PROVENANCE)_VERSION\s*[:=]/u;
const DOCTOR_ENTRY = /^src\/(?:commands|flows)\/doctor[^/]*\.[cm]?[jt]s$/u;
const IMPORT_SPECIFIER =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
const SDK_ALIAS = "openclaw/plugin-sdk/";

const SKIPPED_TOP = new Set([".agents", ".git", ".github", "apps", "docs", "ui"]);
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "test-fixtures",
]);
const TEST_FILE = /\.(?:test|spec|e2e|bench)\.|\.test-|test-(?:helpers?|support|utils)/u;

/**
 * @param {string} relative POSIX path from the repository root.
 * @returns {boolean}
 */
function isExcluded(relative) {
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  return (
    TEST_FILE.test(name) ||
    name.endsWith(".md") ||
    SKIPPED_TOP.has(segments[0] ?? "") ||
    segments.slice(0, -1).some((segment) => SKIPPED_DIRS.has(segment))
  );
}

/**
 * @param {string} relative POSIX path from the repository root.
 * @param {() => string} readSource
 * @returns {boolean}
 */
export function isStateFormatSource(relative, readSource) {
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  if (isExcluded(relative)) {
    return false;
  }
  if (EXACT_FILES.has(relative) || TREES.some((tree) => relative.startsWith(tree))) {
    return true;
  }
  if (PREFIXES.test(relative) || NAMED.test(name)) {
    return true;
  }
  if (segments.slice(0, -1).some((segment) => NAMED_DIRS.has(segment))) {
    return true;
  }
  return CODE.test(name) && FORMAT_VERSION.test(readSource());
}

/**
 * Resolves one import specifier of a repository source file to a file.
 * @param {string} root
 * @param {string} from POSIX path of the importing file.
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveImport(root, from, specifier) {
  let base;
  if (specifier.startsWith(".")) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  } else if (specifier.startsWith(SDK_ALIAS)) {
    base = `src/plugin-sdk/${specifier.slice(SDK_ALIAS.length)}`;
  } else {
    return undefined;
  }
  const stem = base.replace(/\.[cm]?js$/u, "");
  const candidates = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map(
    (ext) => stem + ext,
  );
  candidates.push(base, `${stem}/index.ts`, `${stem}/index.js`);
  return candidates.find((candidate) => {
    try {
      return fs.statSync(path.join(root, candidate)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * @param {string} root
 * @returns {string[]} sorted POSIX paths of the fingerprinted files.
 */
export function listStateFormatSources(root) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {string} relativeDir */
  const walk = (relativeDir) => {
    const entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const skipped = relativeDir ? SKIPPED_DIRS : new Set([...SKIPPED_DIRS, ...SKIPPED_TOP]);
        if (!skipped.has(entry.name)) {
          walk(relative);
        }
      } else if (
        entry.isFile() &&
        isStateFormatSource(relative, () => fs.readFileSync(path.join(root, relative), "utf8"))
      ) {
        found.add(relative);
      }
    }
  };
  walk("");
  for (const entry of [...found].filter((relative) => DOCTOR_ENTRY.test(relative))) {
    const source = fs.readFileSync(path.join(root, entry), "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const callee = resolveImport(root, entry, match[1] ?? match[2] ?? "");
      if (callee && !isExcluded(callee)) {
        found.add(callee);
      }
    }
  }
  return [...found].toSorted();
}

/**
 * @param {string} root
 * @returns {{ schema: 1, stateFormat: string, files: number }}
 */
export function computeStateFormat(root) {
  const files = listStateFormatSources(root);
  const hash = createHash("sha256").update("arxi-state-format-v1\n");
  for (const relative of files) {
    const content = createHash("sha256")
      .update(fs.readFileSync(path.join(root, relative)))
      .digest("hex");
    hash.update(`${relative}\0${content}\n`);
  }
  return { schema: 1, stateFormat: hash.digest("hex"), files: files.length };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? ".");
  process.stdout.write(`${JSON.stringify(computeStateFormat(root))}\n`);
}
