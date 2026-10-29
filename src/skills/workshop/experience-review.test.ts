import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { EXPERIENCE_REVIEW_CONTEXT_LIMITS, runSkillExperienceReview } from "./experience-review.js";
import { createExperienceReviewCandidate } from "./experience-review.test-support.js";
import { createWorkshopSkill, writeWorkshopSkillFile } from "./library.js";
import type { runSkillWorkshopReview } from "./review-run.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const mocks = vi.hoisted(() => ({
  runSkillWorkshopReview: vi.fn(),
  listWorkshopChanges: vi.fn(),
  postWorkshopChangeNotice: vi.fn(),
}));
vi.mock("./review-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-run.js")>()),
  runSkillWorkshopReview: mocks.runSkillWorkshopReview,
}));
vi.mock("./library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library.js")>()),
  listWorkshopChanges: mocks.listWorkshopChanges,
}));
vi.mock("./review-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-outcome.js")>()),
  postWorkshopChangeNotice: mocks.postWorkshopChangeNotice,
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  mocks.runSkillWorkshopReview.mockReset();
  mocks.listWorkshopChanges.mockReset().mockResolvedValue([]);
  mocks.postWorkshopChangeNotice.mockClear();
});
afterEach(async () => {
  await state.cleanup();
});

describe("runSkillExperienceReview", () => {
  it("announces changes committed before the review run failed", async () => {
    const workspaceDir = state.workspaceDir;
    const candidate = await createExperienceReviewCandidate(
      "review-fails-after-commit",
      [{ role: "user", content: "Reconcile the budget.", timestamp: 1 }],
      { workspaceDir, modelId: "gpt-test" },
    );
    const committed: WorkshopChange = {
      id: "c1",
      agentId: "main",
      skillName: "actual-budget-operations",
      action: "patch",
      actor: "review",
      summary: "tightened reconciliation step",
      versionId: "20260101T000000001Z-patch",
      createdAtMs: 1,
    };
    mocks.listWorkshopChanges.mockResolvedValue([committed]);
    // The skill_workshop call committed; the follow-up model request then timed out.
    mocks.runSkillWorkshopReview.mockResolvedValue({
      meta: { durationMs: 1, error: { kind: "timeout", message: "model request timed out" } },
    });

    await expect(runSkillExperienceReview(candidate)).rejects.toThrow("model request timed out");
    expect(mocks.postWorkshopChangeNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: expect.objectContaining({
          sessionKey: candidate.source.sessionKey,
          sessionId: candidate.source.sessionId,
        }),
        changes: [committed],
      }),
    );
  });

  it.each([
    { from: "openai/gpt-test", expected: { provider: "openai", model: "gpt-review" } },
    // An unmapped turn model (Haiku-like cheap turns) keeps reviewing on itself.
    { from: "openai/gpt-other", expected: { provider: "openai", model: "gpt-test" } },
  ])("reviews a $from turn on its mapped model", async (route) => {
    const candidate = await createExperienceReviewCandidate(
      `review-model-${route.expected.model}`,
      [{ role: "user", content: "Reconcile the budget.", timestamp: 1 }],
      { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
    );
    candidate.config = {
      ...candidate.config,
      skills: {
        workshop: { autonomous: { mode: "auto", models: { [route.from]: "openai/gpt-review" } } },
      },
    };
    mocks.runSkillWorkshopReview.mockResolvedValue({ meta: { durationMs: 1 }, payloads: [] });

    await runSkillExperienceReview(candidate);

    expect(mocks.runSkillWorkshopReview).toHaveBeenCalledWith(
      expect.objectContaining(route.expected),
    );
  });

  it("shows the review this conversation's earlier saves and keeps a marked line out of the chat", async () => {
    const candidate = await createExperienceReviewCandidate(
      "review-earlier-saves",
      [{ role: "user", content: "From now on check recruiters on LinkedIn first.", timestamp: 1 }],
      { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
    );
    const earlier: WorkshopChange = {
      id: "c0",
      agentId: "main",
      skillName: "job-opportunity-verification",
      action: "patch",
      actor: "review",
      summary: "Добавила шаг проверки вакансии",
      versionId: "20261021T142200000Z-patch",
      sessionKey: candidate.source.sessionKey,
      createdAtMs: Date.now() - 3 * 60_000,
    };
    const stale: WorkshopChange = {
      ...earlier,
      id: "c-old",
      summary: "a save from two days ago",
      createdAtMs: Date.now() - 48 * 60 * 60_000,
    };
    const committed: WorkshopChange = {
      ...earlier,
      id: "c1",
      summary: "Проверяю рекрутера в LinkedIn до звонка",
      versionId: "20261021T142500000Z-patch",
      createdAtMs: Date.now(),
    };
    mocks.listWorkshopChanges.mockImplementation(
      async (_agentId: string, options: { sessionKey?: string; runId?: string }) =>
        options.sessionKey === candidate.source.sessionKey
          ? [earlier, stale]
          : options.runId
            ? [committed]
            : [],
    );
    let prompt: string | undefined;
    mocks.runSkillWorkshopReview.mockImplementationOnce(
      async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
        prompt = params.prompt;
        return {
          meta: { durationMs: 1 },
          payloads: [
            {
              text: "Patched the skill.\nTELL_USER: Запомнила: рекрутеров сначала проверяю в LinkedIn.",
            },
          ],
        };
      },
    );

    await runSkillExperienceReview(candidate);

    expect(prompt).toContain("Already saved from this conversation");
    expect(prompt).toContain("patch job-opportunity-verification: Добавила шаг проверки вакансии");
    expect(prompt).not.toContain("a save from two days ago");
    // A marked line from the review's reply never reaches the chat.
    expect(mocks.postWorkshopChangeNotice).toHaveBeenCalledWith({
      generation: expect.objectContaining({ sessionKey: candidate.source.sessionKey }),
      changes: [committed],
    });
  });

  it("checks source authority and its accepted anchor together after a later append", async () => {
    const candidate = await createExperienceReviewCandidate(
      "review-append",
      [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
      { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
    );
    mocks.runSkillWorkshopReview.mockImplementation(
      async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
        try {
          const admitted = await params.preparedRunAdmission.admit("embedded");
          const assertCurrent = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
          expect(assertCurrent).toBeDefined();
          assertCurrent!();
          const session = await SessionManager.openAsync(candidate.source, state.workspaceDir);
          await session.appendMessageWithTranscriptAnchorAsync(
            { role: "user", content: "Continue the foreground task.", timestamp: 2 },
            { config: candidate.config },
          );
          const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
          try {
            assertCurrent!();
            expect(
              sql.queries.filter((query) =>
                /\b(?:session_nodes|transcript_event_identities)\b/i.test(query),
              ),
            ).toHaveLength(1);
          } finally {
            sql.restore();
          }
          return { meta: { durationMs: 1 } };
        } finally {
          params.preparedRunAdmission.close();
        }
      },
    );
    await runSkillExperienceReview(candidate);
    expect(mocks.runSkillWorkshopReview).toHaveBeenCalledOnce();
  });

  it.each(["permission", "reset", "replacement", "deletion", "rewrite"] as const)(
    "refuses a Workshop file write after source %s during preparation",
    async (change) => {
      const candidate = await createExperienceReviewCandidate(
        `review-write-${change}`,
        [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
        { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
      );
      await upsertSessionEntryCore(candidate.source, {
        permissionMode: "guarded",
        lifecycleRevision: "original",
      });
      const context = { config: candidate.config, agentId: "main", actor: "review" as const };
      const original =
        "---\nname: procedure\ndescription: Follow the verified procedure\n---\n\nOriginal steps.\n";
      await createWorkshopSkill(context, { name: "procedure", content: original });
      const skillDir = path.join(resolveWorkshopSkillsDir(candidate.config, "main"), "procedure");
      let changed = false;
      const mkdir = fs.mkdir.bind(fs);
      const prepareFile = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        const result = await mkdir(...args);
        if (args[0] === skillDir && !changed) {
          changed = true;
          if (change === "rewrite") {
            const session = await SessionManager.openAsync(candidate.source, state.workspaceDir);
            await session.removeTrailingEntriesAsync((entry) => entry.type === "message");
          } else {
            // Foreign commits bypass host publications after file preparation has yielded.
            const { DatabaseSync } = requireNodeSqlite();
            const writer = new DatabaseSync(candidate.source.storePath);
            try {
              if (change === "permission" || change === "reset") {
                writer
                  .prepare(
                    "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
                  )
                  .run(
                    change === "permission" ? "$.permissionMode" : "$.lifecycleRevision",
                    change === "permission" ? "read-only" : "reset-revision",
                    candidate.source.sessionKey,
                  );
              } else if (change === "deletion") {
                writer
                  .prepare("DELETE FROM session_nodes WHERE session_key = ?")
                  .run(candidate.source.sessionKey);
              } else {
                const replacement = `${candidate.source.sessionId}:replacement`;
                writer.exec("BEGIN IMMEDIATE");
                writer
                  .prepare(
                    "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) SELECT ?, session_key, session_scope, created_at, updated_at FROM session_windows WHERE session_id = ?",
                  )
                  .run(replacement, candidate.source.sessionId);
                writer
                  .prepare(
                    "UPDATE session_nodes SET current_session_id = ?, entry_json = json_set(entry_json, '$.sessionId', ?) WHERE session_key = ?",
                  )
                  .run(replacement, replacement, candidate.source.sessionKey);
                writer.exec("COMMIT");
              }
            } finally {
              writer.close();
            }
          }
        }
        return result;
      });
      mocks.runSkillWorkshopReview.mockImplementation(
        async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
          try {
            const admitted = await params.preparedRunAdmission.admit("embedded");
            const assertLive = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
            expect(assertLive).toBeDefined();
            await expect(
              writeWorkshopSkillFile(
                { ...context, assertLive },
                {
                  name: "procedure",
                  filePath: "SKILL.md",
                  content: original.replace("Original", "Changed"),
                },
              ),
            ).rejects.toThrow("no longer active");
            return { meta: { durationMs: 1 } };
          } finally {
            params.preparedRunAdmission.close();
          }
        },
      );
      try {
        await runSkillExperienceReview(candidate);
        expect(changed).toBe(true);
        expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(original);
      } finally {
        prepareFile.mockRestore();
      }
    },
  );

  it("reviews only the bounded recent suffix of a long source session", async () => {
    // About 1 MiB of older history: far beyond the review budget, as in a
    // natively compacted harness mirror.
    const history = Array.from({ length: 64 }, (_, index) => ({
      role: "user" as const,
      content: `older turn ${index} ${"x".repeat(16 * 1024)}`,
      timestamp: index + 1,
    }));
    const candidate = await createExperienceReviewCandidate(
      "review-bounded-context",
      [...history, { role: "user", content: "Review the completed fixture.", timestamp: 100 }],
      { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
    );
    let reviewed: unknown[] | undefined;
    mocks.runSkillWorkshopReview.mockImplementationOnce(
      async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
        reviewed = params.sessionManager?.buildSessionContext().messages;
        return { meta: { durationMs: 1 } };
      },
    );

    await runSkillExperienceReview(candidate);

    expect(mocks.runSkillWorkshopReview).toHaveBeenCalledOnce();
    expect(reviewed?.at(-1)).toMatchObject({
      role: "user",
      content: "Review the completed fixture.",
    });
    expect(reviewed?.length).toBeGreaterThan(1);
    expect(reviewed?.length).toBeLessThan(history.length + 1);
    expect(JSON.stringify(reviewed).length).toBeLessThanOrEqual(
      EXPERIENCE_REVIEW_CONTEXT_LIMITS.maxBytes,
    );
    expect(JSON.stringify(reviewed)).not.toContain("older turn 0 ");
  });
});
