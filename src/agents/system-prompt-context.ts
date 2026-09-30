import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import { filterProjectScopedCuratedContextFiles } from "./project-memory-bootstrap.js";

const CONTEXT_FILE_ORDER = new Map<string, number>([
  ["agents.md", 10],
  ["soul.md", 20],
  ["identity.md", 30],
  ["user.md", 40],
  ["tools.md", 50],
  ["bootstrap.md", 60],
  ["memory.md", 70],
]);

const DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK =
  /Default heartbeat prompt:\r?\n`(?:Read HEARTBEAT\.md if it exists|Follow the heartbeat monitor scratch context when provided\.)[^`\r\n]*HEARTBEAT_OK\.`/gu;
function normalizeContextFilePath(pathValue: string): string {
  return pathValue.trim().replace(/\\/g, "/");
}

export function isBootstrapContextFile(pathValue: string): boolean {
  return /(^|[\\/])BOOTSTRAP\.md$/iu.test(pathValue.trim());
}

function sanitizeContextFileContentForPrompt(content: string): string {
  // Old workspace templates otherwise route Claude subscriptions to paid extra
  // usage; heartbeat behavior remains in the actual scheduled user turn.
  return content.replaceAll(DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK, "").replace(/\n{3,}/g, "\n\n");
}

export function prepareContextFilesForPrompt(contextFiles: EmbeddedContextFile[]) {
  return (
    contextFiles
      .map((file) => {
        const path = normalizeContextFilePath(file.path);
        const basename = normalizeLowercaseStringOrEmpty(path.slice(path.lastIndexOf("/") + 1));
        return {
          file,
          path,
          basename,
          order: CONTEXT_FILE_ORDER.get(basename) ?? Number.MAX_SAFE_INTEGER,
        };
      })
      // oxlint-disable-next-line unicorn/no-array-sort -- map creates an owned descriptor array.
      .sort((a, b) => {
        if (a.order !== b.order) {
          return a.order - b.order;
        }
        if (a.basename !== b.basename) {
          return a.basename.localeCompare(b.basename);
        }
        return a.path.localeCompare(b.path);
      })
  );
}

export type EffectivePersonalPromptSegment = Readonly<{
  name: "USER.md" | "MEMORY.md";
  path: string;
  text: string;
  sha256: string;
  mandatory: true;
}>;

/** The same filtered and sanitized USER/MEMORY content rendered in Project Context. */
export function selectEffectivePersonalPromptSegments(params: {
  contextFiles?: EmbeddedContextFile[];
  activeProjectKeys?: readonly string[];
  renderedPrompt: string;
}): EffectivePersonalPromptSegment[] {
  const files = prepareContextFilesForPrompt(
    filterProjectScopedCuratedContextFiles(params).filter(
      (file) => typeof file.path === "string" && file.path.trim().length > 0,
    ),
  );
  const seen = new Set<string>();
  return files.flatMap(({ file, basename }) => {
    if (basename !== "user.md" && basename !== "memory.md") {
      return [];
    }
    const content = sanitizeContextFileContentForPrompt(file.content);
    if (!content.trim()) {
      return [];
    }
    const contentDigest = createHash("sha256").update(content).digest("hex");
    if (seen.has(contentDigest)) {
      throw new Error("Effective personal prompt contains duplicate USER/MEMORY content");
    }
    seen.add(contentDigest);
    const heading = `## ${file.path}\n`;
    const headingMatches = params.renderedPrompt.split(heading).length - 1;
    const headingStart = params.renderedPrompt.indexOf(heading);
    const afterHeading = params.renderedPrompt.slice(headingStart + heading.length);
    const separator = afterHeading.startsWith("\n") ? "\n" : "";
    const renderedContentStart = headingStart + heading.length + separator.length;
    const renderedContent = params.renderedPrompt.slice(renderedContentStart);
    // The cache boundary splits the stable prefix with trimEnd(). When the last
    // context file ends in whitespace, count the exact rendered segment rather
    // than restoring whitespace that the provider never receives.
    const trimmedContent = content.trimEnd();
    const contentIsExact = renderedContent.startsWith(content);
    const contentIsBoundaryTrimmed =
      trimmedContent !== content &&
      renderedContent.startsWith(trimmedContent) &&
      renderedContent
        .slice(trimmedContent.length)
        .startsWith("\n<!-- /openclaw:attempt:STABLE -->");
    if (headingMatches !== 1 || (!contentIsExact && !contentIsBoundaryTrimmed)) {
      throw new Error(
        `Effective USER/MEMORY source absent from rendered prompt (headingMatches=${headingMatches})`,
      );
    }
    const text = params.renderedPrompt.slice(
      headingStart,
      renderedContentStart + (contentIsExact ? content.length : trimmedContent.length),
    );
    return [
      {
        name: basename === "user.md" ? ("USER.md" as const) : ("MEMORY.md" as const),
        path: file.path,
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
        mandatory: true as const,
      },
    ];
  });
}

export function buildProjectContextSection(files: ReturnType<typeof prepareContextFilesForPrompt>) {
  if (files.length === 0) {
    return [];
  }
  const lines = ["# Project Context", ""];
  const hasSoulFile = files.some((file) => file.basename === "soul.md");
  const hasMemoryFile = files.some((file) => file.basename === "memory.md");
  const hasUserFile = files.some((file) => file.basename === "user.md");
  lines.push("Loaded project context:");
  if (hasSoulFile) {
    lines.push("SOUL.md: persona/tone. Follow it unless higher-priority instructions override.");
  }
  if (hasMemoryFile) {
    lines.push(
      "MEMORY.md: durable non-profile facts and decisions; use when relevant unless higher-priority instructions override.",
    );
  }
  if (hasUserFile) {
    lines.push(
      "USER.md: durable user preferences and profile directives; follow unless higher-priority instructions override.",
    );
  }
  lines.push("");
  for (const { file } of files) {
    lines.push(`## ${file.path}`, "", sanitizeContextFileContentForPrompt(file.content), "");
  }
  return lines;
}
