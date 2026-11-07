import { afterEach, expect, it, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { createRecoveryHoldLimit } from "./subagent-registry-recovery-hold.js";
import { createSubagentSweeperRun } from "./subagent-registry-sweeper.test-support.js";

afterEach(() => {
  clearAgentRunContext("continuation-turn");
});

function heldDeadRun() {
  const entry = createSubagentSweeperRun();
  entry.execution = {
    status: "running",
    startedAt: Date.now() - 55_000,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
  };
  rotateAgentEventLifecycleGeneration();
  const warn = vi.fn();
  const hold = createRecoveryHoldLimit({ runs: new Map([[entry.runId, entry]]), warn });
  return { entry, hold, warn };
}

it("expires a dead lifecycle's run held for 10 minutes", () => {
  const { entry, hold, warn } = heldDeadRun();
  const start = Date.now();
  expect(hold.expired(entry.runId, entry, start)).toBe(false);
  expect(hold.expired(entry.runId, entry, start + 9 * 60_000)).toBe(false);
  expect(hold.expired(entry.runId, entry, start + 10 * 60_000)).toBe(true);
  expect(warn).toHaveBeenCalledOnce();
});

it("never expires while a live run owns the child session", () => {
  const { entry, hold, warn } = heldDeadRun();
  // The live turn carries a session id the row does not know.
  registerAgentRunContext("continuation-turn", {
    sessionKey: entry.childSessionKey,
    sessionId: "rotated-child-session",
  });
  const start = Date.now();
  expect(hold.expired(entry.runId, entry, start)).toBe(false);
  expect(hold.expired(entry.runId, entry, start + 11 * 60_000)).toBe(false);
  // The clock starts again once that run is gone.
  clearAgentRunContext("continuation-turn");
  expect(hold.expired(entry.runId, entry, start + 12 * 60_000)).toBe(false);
  expect(hold.expired(entry.runId, entry, start + 21 * 60_000)).toBe(false);
  expect(hold.expired(entry.runId, entry, start + 22 * 60_000)).toBe(true);
  expect(warn).toHaveBeenCalledOnce();
});
