import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { prepareAgentRunUserTurn } from "./agent-run-user-turn.js";

const createRecorder = vi.hoisted(() => vi.fn());

vi.mock("../../sessions/user-turn-transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/user-turn-transcript.js")>()),
  createUserTurnTranscriptRecorder: createRecorder,
}));

describe("external input replay custody", () => {
  beforeEach(() => {
    createRecorder.mockReset().mockReturnValue({
      stageApproved: async () => true,
      getProcessingCompletion: () => undefined,
    });
  });

  it.each([
    { backend: true, expected: true },
    { backend: false, expected: false },
  ])(
    "tracks stable Owner ingress only with backend authority (backend=$backend)",
    async ({ backend, expected }) => {
      const sessionEntry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
      await prepareAgentRunUserTurn({
        assertCurrent: () => {},
        request: {
          message: "Synthetic request",
          idempotencyKey: `external:${"a".repeat(64)}`,
          channel: "arxi",
          to: "owner",
          admittedConversationId: "telegram-private:synthetic",
        },
        cfg: {},
        sessionEntry,
        resolvedSessionKey: "agent:main:external:synthetic",
        admittedSessionId: sessionEntry.sessionId,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: backend,
        message: "Synthetic request",
        effectiveTranscriptInputText: "Synthetic request",
        images: [],
        offloadedRefs: [],
        runId: `external:${"a".repeat(64)}`,
        client: backend
          ? { connect: { client: { mode: "backend" }, scopes: ["operator.write"] } }
          : null,
        context: { logGateway: { warn: vi.fn() } },
      } as never);

      expect(createRecorder).toHaveBeenCalledWith(
        expect.objectContaining({
          trackInputCompletion: expected,
          rejectCommittedWithoutCompletion: expected,
        }),
      );
    },
  );
});
