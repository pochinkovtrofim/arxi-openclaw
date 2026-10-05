import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGatewayActiveWorkSnapshot } from "./gateway-active-work.js";

const ARXI_LIFECYCLE_REVIEWED_UPSTREAM_COMMIT = "fc23bc864e4553c2d215e479eeec47b67a0bf943";

const GATEWAY_LIFECYCLE_ACTIVE_PRODUCERS = [
  { id: "command-queue", countKey: "queueSize" },
  { id: "reply-dispatch", countKey: "pendingReplies" },
  { id: "embedded-agent-run", countKey: "embeddedRuns" },
  { id: "background-exec", countKey: "backgroundExecSessions" },
  { id: "cron-run-and-watchers", countKey: "cronRuns" },
  { id: "agent-run-context", countKey: "agentRuns" },
  { id: "acp-turn", countKey: "acpRuns" },
  { id: "media-generation", countKey: "mediaRuns" },
  { id: "gateway-root-request", countKey: "rootRequests" },
  { id: "session-work-admission", countKey: "sessionAdmissions" },
  { id: "session-lifecycle-mutation", countKey: "sessionMutations" },
  { id: "chat-run", countKey: "chatRuns" },
  { id: "queued-chat-turn", countKey: "queuedTurns" },
  { id: "terminal-persistence", countKey: "terminalPersistence" },
  { id: "terminal-session", countKey: "terminalSessions" },
  { id: "migration-and-backup-custody", countKey: "lifecycleWrites" },
] as const;

describe("Arxi lifecycle upgrade inventory", () => {
  it("covers every canonical active-work count", () => {
    const countKeys = Object.keys(createGatewayActiveWorkSnapshot().counts)
      .filter((key) => key !== "totalActive")
      .toSorted();
    const inventoried = GATEWAY_LIFECYCLE_ACTIVE_PRODUCERS.map(
      (entry) => entry.countKey,
    ).toSorted();
    expect(inventoried).toEqual(countKeys);
  });

  it("fails an upstream upgrade until the producer inventory is reviewed", () => {
    expect(readFileSync("ARXI_UPSTREAM_PIN", "utf8").trim()).toBe(
      ARXI_LIFECYCLE_REVIEWED_UPSTREAM_COMMIT,
    );
  });
});
