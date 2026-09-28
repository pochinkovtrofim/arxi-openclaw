import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  readSessionExternalInputReceipt,
} from "../../config/sessions/session-accessor.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { agentInputReceiptHandler } from "./agent-input-receipt.js";

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: vi.fn(),
  readSessionExternalInputReceipt: vi.fn(),
}));
vi.mock("../session-request-agent.js", () => ({
  resolveRequestedSessionAgentId: vi.fn(),
}));

const runId = `external:${"a".repeat(64)}`;
const params = {
  sessionKey: "agent:main:telegram-private:test",
  idempotencyKey: `${runId}:user`,
  expectedRunId: runId,
};

describe("agent.inputReceipt", () => {
  beforeEach(() => {
    vi.mocked(loadSessionEntryReadOnly).mockReset().mockReturnValue({
      sessionId: "session-1",
      updatedAt: 1,
    });
    vi.mocked(readSessionExternalInputReceipt).mockReset().mockReturnValue({
      status: "completed",
      runId,
      completedAt: 1,
    });
    vi.mocked(resolveRequestedSessionAgentId).mockReset().mockReturnValue({
      ok: true,
      agentId: "main",
    });
  });

  it("rejects a non-backend caller before reading any session state", () => {
    const respond = vi.fn();
    agentInputReceiptHandler({ params, respond, client: null } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(loadSessionEntryReadOnly).not.toHaveBeenCalled();
  });

  it("returns only the exact durable receipt and never admits a turn", () => {
    const respond = vi.fn();
    agentInputReceiptHandler({
      params,
      respond,
      client: { connect: { client: { mode: "backend" } } },
      context: { getRuntimeConfig: () => ({}) },
    } as never);
    expect(readSessionExternalInputReceipt).toHaveBeenCalledWith(
      { agentId: "main", sessionKey: params.sessionKey, sessionId: "session-1" },
      params.idempotencyKey,
      params.expectedRunId,
    );
    expect(respond).toHaveBeenCalledWith(true, {
      status: "completed",
      runId,
      completedAt: 1,
    });
  });

  it("keeps a missing or reset session uncertain", () => {
    vi.mocked(loadSessionEntryReadOnly).mockReturnValue(undefined);
    const respond = vi.fn();
    agentInputReceiptHandler({
      params,
      respond,
      client: { connect: { client: { mode: "backend" } } },
      context: { getRuntimeConfig: () => ({}) },
    } as never);
    expect(respond).toHaveBeenCalledWith(true, { status: "uncertain" });
    expect(readSessionExternalInputReceipt).not.toHaveBeenCalled();
  });
});
