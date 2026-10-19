import { resolveRuntimeProcessEntrypointUrl } from "../../../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../../../infra/worker-task-pool.js";
import { prepareFileEdit } from "./edit-diff.js";
import { prepareFileWriteDiff } from "./file-diff.js";
import type {
  FileToolPlanningRequest,
  FileToolPlanningResult,
} from "./file-tool-planning.worker.js";

/** Small plans diff in a few milliseconds; a worker round trip and permit wait cost more. */
const FILE_TOOL_INLINE_PLANNING_MAX_CHARS = 64 * 1024;
const FILE_TOOL_INLINE_PLANNING_MAX_LINES = 2_000;

const pool = new WorkerTaskPool<FileToolPlanningRequest, FileToolPlanningResult>({
  workerClass: "compute",
  sharedCompute: "interactive",
  workerUrl: resolveRuntimeProcessEntrypointUrl("fileToolPlanning"),
});

function countLines(text: string, limit: number): number {
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1 && lines <= limit;) {
    lines++;
    index = text.indexOf("\n", index + 1);
  }
  return lines;
}

function planInline(input: FileToolPlanningRequest): FileToolPlanningResult {
  return input.kind === "edit"
    ? { kind: "edit", plan: prepareFileEdit(input.content, input.edits, input.path) }
    : {
        kind: "write",
        receipt: prepareFileWriteDiff({
          path: input.path,
          content: input.content,
          beforeText: input.beforeText,
          created: input.created,
        }),
      };
}

async function plan(input: FileToolPlanningRequest, signal?: AbortSignal) {
  const texts =
    input.kind === "edit"
      ? [input.content, ...input.edits.flatMap((edit) => [edit.oldText, edit.newText])]
      : [input.content, input.beforeText ?? ""];
  const chars = texts.reduce((sum, text) => sum + text.length, input.path.length);
  if (chars <= FILE_TOOL_INLINE_PLANNING_MAX_CHARS) {
    let lines = 0;
    for (const text of texts) {
      lines += countLines(text, FILE_TOOL_INLINE_PLANNING_MAX_LINES);
    }
    if (lines <= FILE_TOOL_INLINE_PLANNING_MAX_LINES) {
      signal?.throwIfAborted();
      return planInline(input);
    }
  }
  return await pool.run(input, { signal, inputBytes: chars * 2 });
}

export async function planFileEdit(
  input: Omit<Extract<FileToolPlanningRequest, { kind: "edit" }>, "kind">,
  signal?: AbortSignal,
) {
  const result = await plan({ kind: "edit", ...input }, signal);
  if (result.kind !== "edit") {
    throw new Error("Unexpected file edit planning result");
  }
  return result.plan;
}

export async function planFileWriteDiff(
  input: Omit<Extract<FileToolPlanningRequest, { kind: "write" }>, "kind">,
  signal?: AbortSignal,
) {
  const result = await plan({ kind: "write", ...input }, signal);
  if (result.kind !== "write") {
    throw new Error("Unexpected file write planning result");
  }
  return result.receipt;
}
