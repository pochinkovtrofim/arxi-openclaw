// A warm Owner wake restarts the golden's placeholder Gateway in place on the
// Owner's store; the registry must restore again, as a fresh process does.
import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { makeRestartRecoveryRun as makeRunRecord, useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { initSubagentRegistry, testing } from "./subagent-registry.test-helpers.js";

vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

describe("subagent registry after an in-place Gateway restart", () => {
  const fixture = useSubagentRestartRecoveryFixture();
  const { activateGatewayRuntime, dispatchAgent } = fixture;

  it("restores and recovers what a Gateway restarted in place finds in its store", async () => {
    // A golden's placeholder Gateway starts on an empty store and restores nothing.
    await initSubagentRegistry();
    await activateGatewayRuntime();
    await fixture.settle();
    // The Owner's store then holds a child a dead lifecycle left running.
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:warm-restart";
    const runId = "run-warm-restart";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-warm-restart",
      updatedAt: now,
      defaultSessionId: "sess-warm-restart",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      execution: {
        status: "running",
        startedAt: now - 55_000,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
    });
    saveSubagentRegistryToSqlite(new Map([[runId, record]]));
    expect(subagentRuns.get(runId)).toBeUndefined();

    // The warm wake restarts that same Gateway in place on the Owner's store.
    rotateAgentEventLifecycleGeneration();
    await initSubagentRegistry();
    await activateGatewayRuntime();
    await fixture.settle();
    await testing.sweepOnceForTests();
    await fixture.settle();

    const restored = subagentRuns.get(runId);
    expect(restored).toBeDefined();
    expect(dispatchAgent.mock.calls.length > 0 || restored?.execution.status !== "running").toBe(
      true,
    );
  });
});
