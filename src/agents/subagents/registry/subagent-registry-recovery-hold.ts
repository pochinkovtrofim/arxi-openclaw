import { hasAgentRunForSessionKey } from "../../../infra/agent-run-registry-state.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { isRetiredSubagentExecution } from "./subagent-registry-restart-recovery-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

// Restart recovery may hold a dead lifecycle's run for a while (a crash-loop
// pause, a child session still busy), never for good: on 2026-11-06 three
// swarm collectors of a killed Gateway stayed running through two fresh ones
// for 70 minutes, their requester waiting on them, without a log line.
const RECOVERY_HOLD_LIMIT_MS = 10 * 60_000;

/** Tells the sweeper when restart recovery has held a dead lifecycle's run too long. */
export function createRecoveryHoldLimit(params: {
  runs: Map<string, SubagentRunRecord>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  // When restart recovery first held each dead lifecycle's unfinished run.
  let holds = new WeakMap<object, number>();
  return {
    expired(runId: string, entry: SubagentRunRecord, now: number): boolean {
      const key = getSubagentRunRuntimeKey(entry);
      const current = params.runs.get(runId);
      if (
        !current ||
        !isSameSubagentRunOwner(current, entry) ||
        typeof current.execution.endedAt === "number" ||
        !isRetiredSubagentExecution(current) ||
        getAgentRunContext(runId) ||
        // A live run of this process owns the child session, for example the
        // continuation turn of a pending settle wake: recovery may wait on it.
        // Any session id counts: the row's may be missing or rotated.
        hasAgentRunForSessionKey(current.childSessionKey)
      ) {
        holds.delete(key);
        return false;
      }
      const since = holds.get(key);
      if (since === undefined) {
        holds.set(key, now);
        return false;
      }
      if (now - since < RECOVERY_HOLD_LIMIT_MS) {
        return false;
      }
      // The hold clears once the row ends; a sweep that skips it tries again.
      params.warn(
        "restart recovery held a dead lifecycle's subagent run too long; settling it as lost",
        {
          runId,
          heldMs: now - since,
        },
      );
      return true;
    },
    reset() {
      holds = new WeakMap();
    },
  };
}
