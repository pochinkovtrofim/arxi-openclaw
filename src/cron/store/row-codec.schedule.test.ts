import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronSchedule, CronToolsAllowProvenance } from "../types.js";
import { projectCronJobThroughStorageCodec } from "./row-codec.js";

describe("canonical cron schedule JSON round-trip", () => {
  it("round-trips the creator account through canonical job JSON", () => {
    const job = projectCronJobThroughStorageCodec(
      makeCronJob({
        owner: {
          agentId: "main",
          sessionKey: "agent:main:discord:group:ops",
          accountId: "work",
        },
      }),
    );

    expect(job.owner).toEqual({
      agentId: "main",
      sessionKey: "agent:main:discord:group:ops",
      accountId: "work",
    });
  });

  it("round-trips scheduled authority through canonical job JSON", () => {
    const job = projectCronJobThroughStorageCodec(
      makeCronJob({
        owner: {
          agentId: "main",
          sessionKey: "agent:main:discord:group:ops",
          accountId: "work",
        },
        payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "work",
        },
      }),
    );

    expect(job.scheduledToolPolicy).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
  });

  it("round-trips store-private scheduled caller origin without adding a column", () => {
    const job = projectCronJobThroughStorageCodec({
      ...makeCronJob({}),
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "local" },
        mcpToolBindings: [
          { name: "mail__read", serverName: "mail", operation: "tool", toolName: "read" },
        ],
      },
    });

    expect(job.toolsAllowProvenance?.callerOrigin).toEqual({ kind: "local" });
    expect(job.toolsAllowProvenance?.mcpToolBindings).toEqual([
      { name: "mail__read", serverName: "mail", operation: "tool", toolName: "read" },
    ]);
  });
  it.each(["final-executable-surface", "authenticated-requester"] as const)(
    "round-trips private %s provenance through canonical job JSON",
    (source) => {
      const channelRequester = {
        version: 1 as const,
        channel: "discord",
        accountId: "work",
        senderId: "123456789012345678",
      };
      const provenance: CronToolsAllowProvenance =
        source === "final-executable-surface"
          ? { version: 1, source, callerOrigin: { kind: "local" }, channelRequester }
          : { version: 1, source, channelRequester };
      const job = projectCronJobThroughStorageCodec({
        ...makeCronJob({}),
        toolsAllowProvenance: provenance,
      });

      expect(job.toolsAllowProvenance).toEqual(provenance);
    },
  );

  it("keeps private runtime authority out of job_json", () => {
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const job = projectCronJobThroughStorageCodec({
      ...makeCronJob({}),
      runtimeAuthority,
      runtimeAuthorityRecoveryRequired: true,
    });
    expect(job.runtimeAuthority).toBeUndefined();
    expect(job.runtimeAuthorityRecoveryRequired).toBeUndefined();

    const malformed = projectCronJobThroughStorageCodec({
      ...makeCronJob({}),
      runtimeAuthority: { ...runtimeAuthority, version: 2 } as never,
    });
    expect(malformed.runtimeAuthority).toBeUndefined();
  });

  it("round-trips a paced stream without aliasing input config or runtime state", () => {
    const schedule: CronSchedule = {
      kind: "stream",
      command: ["node", "events.mjs"],
      cwd: "/repo",
      mode: "match",
      match: "^ready:",
      batchMs: 100,
      maxBatchBytes: 2_048,
    };
    const triggerState = { cursor: { position: 7 }, items: ["first"] };
    const input = makeCronJob({
      schedule,
      pacing: { min: "15m", max: "4h" },
      state: { lastStatus: "ok", triggerState, nextRunAtMs: 123_000 },
    });
    const before = structuredClone(input);
    const projected = projectCronJobThroughStorageCodec(input);

    expect(projected.schedule).toStrictEqual(schedule);
    expect(projected.pacing).toStrictEqual(input.pacing);
    expect(projected.state).toStrictEqual({ ...input.state, lastRunStatus: "ok" });
    expect(input).toStrictEqual(before);
    expect(Object.is(projected.schedule, input.schedule)).toBe(false);
    expect(Object.is(projected.pacing, input.pacing)).toBe(false);
    expect(Object.is(projected.state, input.state)).toBe(false);
    expect(Object.is(projected.state.triggerState, triggerState)).toBe(false);
    triggerState.cursor.position = 9;
    triggerState.items.push("second");
    expect(projected.state.triggerState).toStrictEqual({
      cursor: { position: 7 },
      items: ["first"],
    });
  });
});
