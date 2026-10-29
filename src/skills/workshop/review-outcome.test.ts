import { beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { assertSkillReviewRunSucceeded, postWorkshopChangeNotice } from "./review-outcome.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntryReadOnly: vi.fn(),
  enqueueSystemEvent: vi.fn(() => true),
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));
vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

describe("assertSkillReviewRunSucceeded", () => {
  it("does not fail a review whose tool calls were denied or errored", () => {
    const warning = setReplyPayloadMetadata(
      { isError: true, text: "⚠️ skill_workshop failed: View it first." },
      { toolErrorWarning: { toolName: "skill_workshop" } },
    );
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: {
          durationMs: 1,
          toolSummary: {
            calls: 3,
            tools: ["sessions_yield", "skill_workshop"],
            failures: 1,
            unresolvedError: { toolName: "skill_workshop" },
          },
        },
        payloads: [warning],
      }),
    ).not.toThrow();
  });

  it("fails on model or runtime errors", () => {
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: { durationMs: 1, error: { kind: "retry_limit", message: "model retries exhausted" } },
      }),
    ).toThrow("model retries exhausted");
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: { durationMs: 1 },
        payloads: [{ isError: true, text: "LLM request failed: 529 overloaded" }],
      }),
    ).toThrow("529 overloaded");
    expect(() => assertSkillReviewRunSucceeded({ meta: { durationMs: 1, aborted: true } })).toThrow(
      "aborted",
    );
  });
});

const change = (overrides: Partial<WorkshopChange>): WorkshopChange => ({
  id: "c1",
  agentId: "main",
  skillName: "actual-budget-operations",
  action: "patch",
  actor: "review",
  summary: "tightened reconciliation step",
  createdAtMs: 1,
  ...overrides,
});

describe("postWorkshopChangeNotice", () => {
  const generation = (sessionKey: string) => ({
    agentId: "main",
    storePath: "/tmp/sessions.json",
    sessionKey,
    sessionId: "reviewed-session",
    lifecycleRevision: "reviewed-revision",
  });
  const post = (changes: WorkshopChange[]) =>
    postWorkshopChangeNotice({ generation: generation("agent:main:telegram:direct:42"), changes });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "reviewed-session",
      lifecycleRevision: "reviewed-revision",
    });
  });

  it("stays quiet when the review changed nothing", () => {
    post([]);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps a change out of the chat and gives the next turn the exact revert", () => {
    post([
      change({ id: "c2", versionId: "20260101T000000002Z-patch", createdAtMs: 2 }),
      change({
        id: "c1",
        summary: "first pass",
        versionId: "20260101T000000001Z-patch",
        createdAtMs: 1,
      }),
      change({
        id: "c3",
        skillName: "release-notes",
        action: "create",
        summary: "drafting release notes",
        createdAtMs: 3,
      }),
      change({
        id: "c4",
        skillName: "release-notes",
        summary: "fixed a typo",
        createdAtMs: 4,
      }),
    ]);
    // The next turn learns the exact revert: archive what was created; restore what was edited
    // to the version saved before the review's first change of it.
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [event] = mocks.enqueueSystemEvent.mock.calls[0] as unknown as [string];
    expect(event).toContain(
      "updated actual-budget-operations (tightened reconciliation step); created release-notes (drafting release notes).",
    );
    expect(event).toContain("The user was not told in chat; do not bring it up yourself.");
    expect(event).toContain(
      "skill_workshop action=restore name=actual-budget-operations version=20260101T000000001Z-patch;",
    );
    expect(event).toContain('skill_workshop action=archive name=release-notes reason="undo"');
  });

  it("leaves a conversation reset since the review started untouched", () => {
    // A Gateway reset keeps the sessionId and rotates the lifecycle revision.
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "reviewed-session",
      lifecycleRevision: "reset-revision",
    });
    post([change({})]);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
