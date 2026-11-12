import { expectDefined } from "@openclaw/normalization-core";
import { assert, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isFreshContextCronSessionTarget } from "../cron/session-target.js";
import type { CronJob } from "../cron/types.js";
import {
  addAgentTurnJob,
  createCronConfig,
  loadCronService,
  resetGatewayCronMocks,
  runCronIsolatedAgentTurnMock,
  runCronSessionTurnMock,
} from "./server-cron.test-support.js";

describe("Gateway Cron session target routing", () => {
  beforeEach(resetGatewayCronMocks);

  it.each([
    {
      kind: "opaque explicit target",
      agentId: undefined,
      sessionKey: "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
      expectedAgentId: "main",
      expectedSessionKey: "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
    },
    {
      kind: "legacy main alias",
      agentId: "ops",
      sessionKey: "agent:main:main",
      expectedAgentId: "ops",
      expectedSessionKey: "agent:ops:main",
    },
  ])(
    "routes $kind through to controller-owned cron turns",
    async ({ agentId, sessionKey, expectedAgentId, expectedSessionKey }) => {
      const cfg = createCronConfig("server-cron-custom-session");
      cfg.agents = {
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      };
      const state = loadCronService(cfg);
      try {
        const job = await addAgentTurnJob(state, "custom-session", "hello", {
          agentId,
          sessionTarget: `session:${sessionKey}`,
        });

        await state.cron.run(job.id, "force");

        expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
        expect(runCronSessionTurnMock).toHaveBeenCalledOnce();
        const [options] = expectDefined(runCronSessionTurnMock.mock.calls[0], "session turn");
        expect(options).toMatchObject({
          agentId: expectedAgentId,
          sessionKey: expectedSessionKey,
          text: "hello",
          job: { id: job.id },
        });
        expect(options.cfg).toBe(cfg);
        expect(options.admissionSource).toBeDefined();
        expect(options.prepare).toBeTypeOf("function");
        expect(options.assertCurrent).toBeTypeOf("function");
      } finally {
        assert(typeof state.cron.stopAndDrain === "function", "Gateway cron drain is unavailable");
        await state.cron.stopAndDrain();
      }
    },
  );

  it("refuses a stored job whose explicit session belongs to another agent", async () => {
    const cfg = createCronConfig("server-cron-mismatched-session");
    cfg.agents = {
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, ops: {} },
    };
    const state = loadCronService(cfg);
    try {
      const job = await addAgentTurnJob(state, "mismatched-session", "hello", {
        agentId: "main",
        sessionTarget: "session:agent:ops:scheduled-report",
        deleteAfterRun: false,
      });

      await state.cron.run(job.id, "force");

      expect(state.cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: expect.stringMatching(/session target belongs to another agent/i),
      });
      expect(runCronSessionTurnMock).not.toHaveBeenCalled();
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
    } finally {
      assert(typeof state.cron.stopAndDrain === "function", "Gateway cron drain is unavailable");
      await state.cron.stopAndDrain();
    }
  });

  it("runs a declared job in its named session on detached execution", async () => {
    const cfg = createCronConfig("server-cron-declared-session");
    cfg.cron = { ...cfg.cron, freshContextSessions: ["arxi-proactive-steward"] };
    const state = loadCronService(cfg);
    try {
      const job = await addAgentTurnJob(state, "declared-session", "hello", {
        sessionTarget: "session:arxi-proactive-steward",
        declarationKey: "arxi:proactive-steward:main",
      });
      await state.cron.run(job.id, "force");
      // The detached run owns fresh context, held runs and conversation-owned failures.
      expect(runCronSessionTurnMock).not.toHaveBeenCalled();
      const options = expectDefined(
        runCronIsolatedAgentTurnMock.mock.calls[0],
        "declared turn",
      )[0] as unknown as { cfg: OpenClawConfig; job: CronJob };
      expect(options).toMatchObject({ sessionKey: "arxi-proactive-steward", job: { id: job.id } });
      expect(
        isFreshContextCronSessionTarget(options.cfg.cron?.freshContextSessions, options.job.sessionTarget),
      ).toBe(true);
    } finally {
      assert(typeof state.cron.stopAndDrain === "function", "Gateway cron drain is unavailable");
      await state.cron.stopAndDrain();
    }
  });

  it.each(["current", "isolated"] as const)(
    "keeps %s turns on detached execution despite a captured result conversation",
    async (sessionTarget) => {
      const cfg = createCronConfig(`server-cron-detached-${sessionTarget}`);
      const state = loadCronService(cfg);
      try {
        const job = await addAgentTurnJob(state, "detached", "hello", {
          sessionTarget,
          sessionKey: "agent:main:captured-result",
        });
        await state.cron.run(job.id, "force");
        expect(runCronSessionTurnMock).not.toHaveBeenCalled();
        const [options] = expectDefined(
          runCronIsolatedAgentTurnMock.mock.calls[0],
          "detached turn",
        );
        expect(options).toMatchObject({ sessionKey: `cron:${job.id}` });
      } finally {
        assert(typeof state.cron.stopAndDrain === "function", "Gateway cron drain is unavailable");
        await state.cron.stopAndDrain();
      }
    },
  );
});
