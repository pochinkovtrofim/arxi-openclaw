import { afterEach, expect, it, vi } from "vitest";
import { WorkerTaskPool } from "../../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createAgentToolExecutionBudget } from "../../agent-tool-source-execution-guard.js";
import { createEditTool } from "./edit.js";
import { prepareFileWriteDiff } from "./file-diff.js";
import * as planning from "./file-tool-planning.js";
import { createWriteTool } from "./write.js";

afterEach(() => vi.restoreAllMocks());

it.each(
  (["edit", "write"] as const).flatMap((kind) =>
    (["active", "revoked", "aborted"] as const).map((authority) => ({ kind, authority })),
  ),
)(
  "rechecks $authority authority after $kind planning before mutation",
  async ({ kind, authority }) => {
    const prepared = createDeferredCore();
    const release = createDeferredCore();
    const delayResult = async <T>(pending: Promise<T>): Promise<T> => {
      const result = await pending;
      prepared.resolve();
      await release.promise;
      return result;
    };
    if (kind === "edit") {
      const plan = planning.planFileEdit;
      vi.spyOn(planning, "planFileEdit").mockImplementation((...args) =>
        delayResult(plan(...args)),
      );
    } else {
      const plan = planning.planFileWriteDiff;
      vi.spyOn(planning, "planFileWriteDiff").mockImplementation((...args) =>
        delayResult(plan(...args)),
      );
    }

    let content = "before\n";
    const writeFile = vi.fn(async (_path: string, value: string) => {
      content = value;
    });
    const mkdir = vi.fn(async () => {});
    const operations = {
      resolveQueueKey: (target: string) => target,
      access: async () => {},
      mkdir,
      writeFile,
      readFile: async () => Buffer.from(content),
      statFile: async () => ({
        type: "file" as const,
        size: Buffer.byteLength(content),
        mtimeMs: 1,
      }),
    };
    const controller = new AbortController();
    let current = true;
    const budget = createAgentToolExecutionBudget({
      signal: controller.signal,
      abort: (error) => controller.abort(error),
      isCurrent: () => current,
    });
    const pending = budget.run(() =>
      kind === "edit"
        ? createEditTool("/workspace", { operations }).execute(
            "planning",
            { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] },
            controller.signal,
          )
        : createWriteTool("/workspace", { operations }).execute(
            "planning",
            { path: "example.txt", content: "after\n" },
            controller.signal,
          ),
    );
    void pending.catch(prepared.reject);
    try {
      await prepared.promise;
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(content).toBe("before\n");
      if (authority === "revoked") {
        current = false;
      } else if (authority === "aborted") {
        controller.abort(new Error("Planning cancelled"));
      }
      release.resolve();
      if (authority === "active") {
        await expect(pending).resolves.toMatchObject({ details: { changed: true } });
        expect(writeFile).toHaveBeenCalledOnce();
        expect(content).toBe("after\n");
      } else {
        await expect(pending).rejects.toThrow(
          authority === "aborted" ? "Planning cancelled" : "execution scope is no longer active",
        );
        expect(mkdir).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(content).toBe("before\n");
      }
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  },
);

it("plans small writes and edits inline and larger ones in the planning worker", async () => {
  const run = vi.spyOn(WorkerTaskPool.prototype, "run");
  const small = "alpha\nbeta\n";
  await expect(
    planning.planFileEdit({
      path: "small.txt",
      content: small,
      edits: [{ oldText: "beta", newText: "gamma" }],
    }),
  ).resolves.toMatchObject({ changed: true, content: "alpha\ngamma\n" });
  await expect(
    planning.planFileWriteDiff({ path: "small.txt", content: "alpha\n", beforeText: small }),
  ).resolves.toMatchObject({ firstChangedLine: 2 });
  expect(run).not.toHaveBeenCalled();

  // Either bound alone (2,000 lines or 64 KiB) moves planning off the main thread.
  const manyLines = "x\n".repeat(2_000);
  const wide = `${"y".repeat(64 * 1024)}\nend\n`;
  for (const content of [manyLines, wide]) {
    const inlineReceipt = prepareFileWriteDiff({ path: "big.txt", content, beforeText: small });
    await expect(
      planning.planFileWriteDiff({ path: "big.txt", content, beforeText: small }),
    ).resolves.toEqual(inlineReceipt);
  }
  expect(run).toHaveBeenCalledTimes(2);
});

it("rejects an already aborted inline plan without mutating", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Planning cancelled"));
  await expect(
    planning.planFileEdit(
      { path: "small.txt", content: "a\n", edits: [{ oldText: "a", newText: "b" }] },
      controller.signal,
    ),
  ).rejects.toThrow("Planning cancelled");
});
