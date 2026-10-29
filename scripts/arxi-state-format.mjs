#!/usr/bin/env node
// Fingerprints the source that defines persisted state formats and their repair.
//
// Ro runs `doctor --fix` and a memory index offline on an owner's first wake
// after an OpenClaw change. Two builds with the same fingerprint carry the same
// migrations, schema versions and doctor repairs, so state that one build's
// doctor completed needs nothing from the other's and that wake can skip it.
// Every fingerprint change makes every Owner wait for that repair on its next
// wake, so the set holds what defines or repairs a stored shape, not the
// runtime that only reads it: the Gateway normalizes cron rows as it loads
// them, and a memory index records the chunking, embedding-input and provenance
// versions that make it stale. Schema versions, migrations and doctor itself
// always count; a file that only looks related still costs one unnecessary
// repair, while a missed migration would skip a needed one.
//
// Doctor reaches plugin repairs through runtime facades that no import graph
// shows, so repairs inside the persisted-state owners join by name. Of the
// modules doctor imports directly, those that repair, recover or migrate state
// join as its callees; the rest is the runtime doctor shares with the Gateway.
// The hash covers the selected files only, so between two builds a change to
// these rules counts only when it changes the selection; comparing two commits
// cannot tell, and counts any edit of this script.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const EXACT_FILES = new Set(["package.json", "src/cli/program/register.maintenance.ts"]);
// Inside the persisted-state owners only the files that define or repair a
// stored shape count.
const STATE_OWNERS = [
  "src/state/",
  "src/config/sessions/",
  "src/memory/",
  "src/memory-host-sdk/",
  "src/plugin-state/",
  "src/infra/",
  "packages/memory-host-sdk/src/host/",
  "extensions/memory-core/src/",
];
const STATE_SHAPE =
  /schema|migrat|legacy|backfill|repair|maintenance|provenance|chunk|embedding-input|reindex|recovery|retire|state-format|(?:^|-)versions?\./iu;
// Runtime there that refuses stored state until Doctor converts it, or that
// Doctor calls through a facade, belongs to the format as well.
const DOCTOR_CONTRACT =
  /MigrationRequired|Doctor owns|[Ff]or ?Doctor\b|Admit Doctor|openclaw doctor/u;
const NAMED = /doctor|migrat|legacy/iu;
const NAMED_DIRS = new Set(["doctor", "migrate", "migration", "migrations", "legacy"]);
const DOCTOR_CALLEE = /repair|recovery|backup|capture|retire|migrat|schema|legacy/iu;
const CODE = /\.(?:[cm]?[jt]s)$/u;
// A persisted-format version anywhere in the tree joins the set by content.
const FORMAT_VERSION =
  /\bconst\s+[A-Z0-9_]*(?:SCHEMA|FORMAT|STORE|STATE|CHUNKING|PROVENANCE)_VERSION\s*[:=]/u;
const DOCTOR_ENTRY = /^src\/(?:commands|flows)\/doctor[^/]*\.[cm]?[jt]s$/u;
const IMPORT_SPECIFIER =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
const SDK_ALIAS = "openclaw/plugin-sdk/";

// Development tools and QA scenarios never run in the guest.
const SKIPPED_TOP = new Set([".agents", ".git", ".github", "apps", "docs", "qa", "scripts", "ui"]);
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
  if (EXACT_FILES.has(relative) || NAMED.test(name)) {
    return true;
  }
  if (segments.slice(0, -1).some((segment) => NAMED_DIRS.has(segment))) {
    return true;
  }
  const owned = STATE_OWNERS.some((owner) => relative.startsWith(owner));
  if (owned && STATE_SHAPE.test(name)) {
    return true;
  }
  if (!CODE.test(name)) {
    return false;
  }
  const source = readSource();
  return FORMAT_VERSION.test(source) || (owned && DOCTOR_CONTRACT.test(source));
}

/**
 * A source tree to fingerprint: its regular files, by POSIX path from the
 * repository root, and their contents.
 * @typedef {{ paths: Set<string>, read: (relative: string) => Buffer }} SourceTree
 */

/**
 * @param {string} root a checkout or an extracted source archive.
 * @returns {SourceTree}
 */
export function fileTree(root) {
  /** @type {Set<string>} */
  const paths = new Set();
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
      } else if (entry.isFile()) {
        paths.add(relative);
      }
    }
  };
  walk("");
  return { paths, read: (relative) => fs.readFileSync(path.join(root, relative)) };
}

/**
 * Commit `rev` of the Git repository at `root`, as `git archive` exports it to
 * the build: regular files only, read in one batch.
 * @param {string} root
 * @param {string} rev
 * @returns {SourceTree}
 */
export function gitTree(root, rev) {
  /** @param {string[]} args @param {string} [input] */
  const git = (args, input) =>
    execFileSync("git", ["-C", root, ...args], { input, maxBuffer: 2 ** 31 - 1 });
  /** @type {Map<string, string>} */
  const blobs = new Map();
  const listing = git(["ls-tree", "-r", "-z", "--full-tree", rev]).toString("utf8");
  for (const entry of listing.split("\0")) {
    const match = /^100[0-7]{3} blob ([0-9a-f]+)\t(.+)$/su.exec(entry);
    if (match?.[1] && match[2] && !isExcluded(match[2])) {
      blobs.set(match[2], match[1]);
    }
  }
  /** @type {Map<string, Buffer> | undefined} */
  let contents;
  return {
    paths: new Set(blobs.keys()),
    read: (relative) => {
      if (!contents) {
        contents = new Map();
        const ids = [...new Set(blobs.values())];
        const batch = git(["cat-file", "--batch"], `${ids.join("\n")}\n`);
        let offset = 0;
        for (const id of ids) {
          const header = batch.indexOf(10, offset);
          const size = Number(batch.toString("latin1", offset, header).split(" ")[2]);
          contents.set(id, batch.subarray(header + 1, header + 1 + size));
          offset = header + 2 + size;
        }
      }
      const content = contents.get(blobs.get(relative) ?? "");
      if (!content) {
        throw new Error(`${rev}: no regular file ${relative}`);
      }
      return content;
    },
  };
}

/**
 * Resolves one import specifier of a repository source file to a file.
 * @param {SourceTree} tree
 * @param {string} from POSIX path of the importing file.
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveImport(tree, from, specifier) {
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
  return candidates.find((candidate) => tree.paths.has(candidate));
}

/**
 * @param {SourceTree} tree
 * @returns {string[]} sorted POSIX paths of the fingerprinted files.
 */
export function listStateFormatSources(tree) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const relative of tree.paths) {
    if (isStateFormatSource(relative, () => tree.read(relative).toString("utf8"))) {
      found.add(relative);
    }
  }
  for (const entry of [...found].filter((relative) => DOCTOR_ENTRY.test(relative))) {
    const source = tree.read(entry).toString("utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const callee = resolveImport(tree, entry, match[1] ?? match[2] ?? "");
      if (callee && !isExcluded(callee) && DOCTOR_CALLEE.test(path.posix.basename(callee))) {
        found.add(callee);
      }
    }
  }
  return [...found].toSorted();
}

/**
 * @param {SourceTree} tree
 * @returns {Map<string, string>} each fingerprinted file's content digest.
 */
function stateFormatDigests(tree) {
  return new Map(
    listStateFormatSources(tree).map((relative) => [
      relative,
      createHash("sha256").update(tree.read(relative)).digest("hex"),
    ]),
  );
}

/**
 * @param {SourceTree} tree
 * @returns {{ schema: 1, stateFormat: string, files: number }}
 */
export function computeStateFormat(tree) {
  const digests = stateFormatDigests(tree);
  const hash = createHash("sha256").update("arxi-state-format-v2\n");
  for (const [relative, digest] of digests) {
    hash.update(`${relative}\0${digest}\n`);
  }
  return { schema: 1, stateFormat: hash.digest("hex"), files: digests.size };
}

/**
 * The fingerprinted files a change adds, removes or edits. None means both
 * trees have the same fingerprint, so an Owner's first wake on the newer one
 * skips the repair.
 * @param {SourceTree} base
 * @param {SourceTree} head
 * @returns {string[]}
 */
export function changedStateFormatSources(base, head) {
  const before = stateFormatDigests(base);
  const after = stateFormatDigests(head);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((relative) => before.get(relative) !== after.get(relative))
    .toSorted();
}

const RULES = "scripts/arxi-state-format.mjs";

/**
 * What the change from commit `base` to `head` of the Git repository at `root`
 * does to the fingerprint: the fingerprinted files it adds, removes or edits
 * under `head`'s rules. A build of `base` hashed under its own rules, so when
 * this script differs the change counts it as well.
 * @param {string} root
 * @param {string} base
 * @param {string} head
 * @returns {string[]}
 */
export function changedStateFormat(root, base, head) {
  const changed = changedStateFormatSources(gitTree(root, base), gitTree(root, head));
  const rules = execFileSync("git", ["-C", root, "diff", "--name-only", base, head, "--", RULES]);
  return rules.length ? [RULES, ...changed] : changed;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  if (process.argv[2] === "--changed") {
    // --changed BASE [HEAD]: what a change does to the fingerprint, in this checkout.
    const changed = changedStateFormat(
      ".",
      process.argv[3] ?? "origin/main",
      process.argv[4] ?? "HEAD",
    );
    process.stdout.write(`${changed.join("\n")}\n`);
  } else {
    const root = path.resolve(process.argv[2] ?? ".");
    process.stdout.write(`${JSON.stringify(computeStateFormat(fileTree(root)))}\n`);
  }
}
