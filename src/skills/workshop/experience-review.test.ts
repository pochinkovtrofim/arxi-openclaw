import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { runWithAgentToolSourceExecutionScope } from "../../agents/agent-tool-source-execution-guard.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runBeforeAgentReplyForTurn } from "../../plugins/before-agent-reply.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
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
  runEmbeddedAgent: vi.fn(),
  listWorkshopChanges: vi.fn(),
  postWorkshopChangeNotice: vi.fn(),
}));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: mocks.runEmbeddedAgent,
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
  it("does not dispatch user reply hooks for a detached experience review", async () => {
    const candidate = await createExperienceReviewCandidate(
      "review-user-reply-hook",
      [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
      { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
    );
    setRuntimeConfigSnapshot(candidate.config);
    const handler = vi.fn(() => ({ handled: true }));
    const reviewModel = vi.fn(() => ({ meta: { durationMs: 1 } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler, eligibleTriggers: ["user"] },
      ]),
    );
    try {
      // Prove the registered hook can claim the foreground turn before reviewing it.
      await expect(
        runBeforeAgentReplyForTurn({
          runId: "review-user-reply-hook",
          trigger: candidate.ctx.foregroundPromptContext.trigger,
          event: { cleanedBody: "Remember the verified procedure." },
          context: { sessionKey: candidate.source.sessionKey },
        }),
      ).resolves.toEqual({ handled: true });
      expect(handler).toHaveBeenCalledOnce();
      handler.mockClear();

      const review = await vi.importActual<{
        runSkillWorkshopReview: typeof runSkillWorkshopReview;
      }>("./review-run.js");
      mocks.runSkillWorkshopReview.mockImplementation(review.runSkillWorkshopReview);
      mocks.runEmbeddedAgent.mockImplementation(
        async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
          const admitted = await params.preparedRunAdmission.admit("embedded");
          const hookResult = await runBeforeAgentReplyForTurn({
            runId: params.runId,
            trigger: params.trigger,
            event: { cleanedBody: params.prompt },
            context: { sessionKey: params.sessionKey, sessionId: params.sessionId },
            assertCurrent: resolveAdmittedRunActiveAssertion(admitted, params.abortSignal),
          });
          return hookResult?.handled ? { meta: { durationMs: 1 } } : reviewModel();
        },
      );

      await runSkillExperienceReview(candidate);

      expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();
      expect(reviewModel).toHaveBeenCalledOnce();
    } finally {
      mocks.runEmbeddedAgent.mockReset();
      resetGlobalHookRunner();
    }
  });

  it("announces changes committed before the review run failed", async () => {
    const workspaceDir = state.workspaceDir;
    const candidate = await createExperienceReviewCandidate(
      "review-fails-after-commit",
      [{ role: "user", content: "Reconcile the budget.", timestamp: 1 }],
      { workspaceDir, modelId: "gpt-test" },
    );
    setRuntimeConfigSnapshot(candidate.config);
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
      config: candidate.config,
      generation: expect.objectContaining({ sessionKey: candidate.source.sessionKey }),
      runId: expect.any(String),
      changes: [committed],
    });
  });

  it("keeps a later append live without MAIN SQL and denies unprepared use after revocation", async () => {
    const candidate = await createExperienceReviewCandidate(
      "review-append",
      [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
      { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
    );
    setRuntimeConfigSnapshot(candidate.config);
    mocks.runSkillWorkshopReview.mockImplementation(
      async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
        try {
          const admitted = await params.preparedRunAdmission.admit("embedded");
          const assertCurrent = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
          expect(assertCurrent).toBeDefined();
          const session = await SessionManager.openAsync(candidate.source, state.workspaceDir);
          const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
          try {
            for (let index = 0; index < 5; index += 1) {
              assertCurrent!();
            }
            expect(sql.queries).toEqual([]);
          } finally {
            sql.restore();
          }
          await session.appendMessageWithTranscriptAnchorAsync(
            { role: "user", content: "Continue the foreground task.", timestamp: 2 },
            { config: candidate.config },
          );
          const refreshedSql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
          try {
            // The model response resumes before the next tool can prepare its source scope.
            assertCurrent!();
            await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
              assertCurrent!();
            });
            expect(refreshedSql.queries).toEqual([]);
          } finally {
            refreshedSql.restore();
          }
          await upsertSessionEntryCore(candidate.source, { permissionMode: "read-only" });
          // Provider dispatch checks the admitted assertion without preparing another scope.
          expect(() => assertCurrent!()).toThrow("no longer active");
          return { meta: { durationMs: 1 } };
        } finally {
          params.preparedRunAdmission.close();
        }
      },
    );
    await runSkillExperienceReview(candidate);
    expect(mocks.runSkillWorkshopReview).toHaveBeenCalledOnce();
  });

  it.each(["permission", "reset", "replacement", "deletion", "rewrite", "membership"] as const)(
    "refuses a Workshop file write after source %s during preparation",
    async (change) => {
      const candidate = await createExperienceReviewCandidate(
        `review-write-${change}`,
        [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
        { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
      );
      setRuntimeConfigSnapshot(candidate.config);
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
          } else if (change === "membership") {
            await addSessionMember(candidate.source, {
              identityId: "new-member",
              addedBy: "owner",
              expectedSessionId: candidate.source.sessionId,
            });
          } else if (change === "deletion") {
            await deleteSessionEntryLifecycle({
              agentId: "main",
              storePath: candidate.source.storePath,
              target: {
                canonicalKey: candidate.source.sessionKey,
                storeKeys: [candidate.source.sessionKey],
              },
              archiveTranscript: false,
            });
          } else {
            await upsertSessionEntryCore(
              candidate.source,
              change === "permission"
                ? { permissionMode: "read-only" }
                : change === "reset"
                  ? { lifecycleRevision: "reset-revision" }
                  : { sessionId: `${candidate.source.sessionId}:replacement` },
            );
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
              runWithAgentToolSourceExecutionScope(assertLive, () =>
                writeWorkshopSkillFile(
                  { ...context, assertLive },
                  {
                    name: "procedure",
                    filePath: "SKILL.md",
                    content: original.replace("Original", "Changed"),
                  },
                ),
              ),
            ).rejects.toThrow("no longer active");
            await expect(
              runWithAgentToolSourceExecutionScope(assertLive, () =>
                writeWorkshopSkillFile(
                  { ...context, assertLive },
                  { name: "procedure", filePath: "SKILL.md", content: "must stay denied" },
                ),
              ),
            ).rejects.toThrow();
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
