import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  consumeCronNextCheckProposal,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { createCronTool } from "./cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

const jobId = "existing-job";
const configRevision = "sha256:stored-job";

async function withRepairTool(
  run: (
    tool: ReturnType<typeof createCronTool>,
    calls: Array<[string, unknown]>,
    bindings: Map<string, unknown>,
  ) => Promise<void>,
  payload: Record<string, unknown> = {
    kind: "agentTurn",
    message: "scan",
    toolsAllow: ["browser"],
  },
) {
  const runId = "failure-repair-tool-run";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const capability = createCronCreatorAuthorityCapability(
    runId,
    { kind: "unknown" },
    { source: "failure-repair", jobId },
  )!;
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:owner",
    operationalRunInstance,
    delegatedAuthority: { ...authority, kind: "local" },
  };
  const calls: Array<[method: string, params: unknown]> = [];
  const bindings = new Map<string, unknown>();
  try {
    await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
        const tool = createCronTool(
          {
            runId,
            agentSessionKey: identity.sessionKey,
            // The repair turn's own final tool surface, as the runner captures it.
            creatorToolAllowlist: [
              "browser",
              "read",
              "automations",
              {
                name: "google_workspace__sheets_append",
                aliasName: "sheets_append",
                mcp: {
                  serverName: "google_workspace",
                  operation: "tool",
                  toolName: "sheets_append",
                },
              },
            ],
            creatorToolAllowlistCaptureRef: {
              value: { version: 1, source: "final-executable-surface" },
            },
          },
          {
            callGatewayTool: async <T>(method: string, _options: unknown, params: unknown) => {
              const caller = getGatewayToolCallerIdentity();
              expect(caller?.cronManagementGrant).toBeDefined();
              bindings.set(method, caller?.cronMcpToolBindings);
              return await withCronManagementGrant(
                caller!.cronManagementGrant!,
                identity,
                method,
                async () => {
                  calls.push([method, params]);
                  return (
                    method === "cron.get" ? { id: jobId, configRevision, payload } : { id: jobId }
                  ) as T;
                },
              );
            },
          },
        );
        await run(tool, calls, bindings);
      }),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

async function withAdminTool(
  origin: "unknown" | "channel-owner",
  run: (tool: ReturnType<typeof createCronTool>, calls: Array<[string, unknown]>) => Promise<void>,
  payload?: Record<string, unknown>,
) {
  const runId = "admin-management-tool-run";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const capability = createCronCreatorAuthorityCapability(
    runId,
    origin === "channel-owner" ? { kind: "external", channel: "discord" } : { kind: origin },
    origin === "channel-owner"
      ? { source: "channel-owner", isCurrent: () => true }
      : { source: "control-ui-admin" },
  )!;
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    delegatedAuthority: { ...authority, kind: "local" },
  };
  const calls: Array<[method: string, params: unknown]> = [];
  const resolveCreator = vi.fn(async () => {
    throw new Error("Admin management must not recapture the creator's tool authority");
  });
  try {
    await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
        const tool = createCronTool(
          {
            runId,
            agentSessionKey: identity.sessionKey,
            resolveCreatorToolAuthority: resolveCreator,
          },
          {
            callGatewayTool: async <T>(method: string, _options: unknown, params: unknown) => {
              const caller = getGatewayToolCallerIdentity();
              expect(caller?.cronCreatorAuthorityGrant).toBeUndefined();
              expect(caller?.cronManagementGrant).toBeDefined();
              return await withCronManagementGrant(
                caller!.cronManagementGrant!,
                identity,
                method,
                async () => {
                  getCronManagementAuthority(identity)!();
                  calls.push([method, params]);
                  return (
                    method === "cron.get" ? { id: jobId, configRevision, payload } : { id: jobId }
                  ) as T;
                },
              );
            },
          },
        );
        await run(tool, calls);
        expect(resolveCreator).not.toHaveBeenCalled();
      }),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

describe("admin automation management", () => {
  it.each(["channel-owner"] as const)(
    "permits %s command edits without recapturing creator authority",
    async (origin) => {
      await withAdminTool(origin, async (tool, calls) => {
        const patch = {
          payload: { kind: "command", argv: ["printf", "proof"], timeoutSeconds: 30 },
        };
        await expect(
          tool.execute("command-update", { action: "update", jobId, job: patch }),
        ).resolves.toMatchObject({ details: { id: jobId } });
        expect(calls).toEqual([["cron.update", { id: jobId, patch }]]);
      });
    },
  );

  it("inherits a stored command kind when clearing its timeout", async () => {
    await withAdminTool(
      "unknown",
      async (tool, calls) => {
        await tool.execute("timeout-update", {
          action: "update",
          jobId,
          job: { payload: { timeoutSeconds: null } },
        });
        expect(calls).toEqual([
          ["cron.get", { id: jobId }],
          [
            "cron.update",
            {
              id: jobId,
              expectedConfigRevision: configRevision,
              patch: { payload: { kind: "command", timeoutSeconds: null } },
            },
          ],
        ]);
      },
      { kind: "command", argv: ["printf", "proof"] },
    );
  });

  it("visibly refuses unsupported next_check", async () => {
    await withAdminTool("unknown", async (tool, calls) => {
      await expect(tool.execute("unsupported", { action: "next_check", in: "1m" })).rejects.toThrow(
        "Use the Automations page for other actions",
      );
      expect(calls).toEqual([]);
    });
  });
});

describe("failure-repair automation access", () => {
  it("gives the failing job tools this conversation has, by canonical name", async () => {
    await withRepairTool(async (tool, calls, bindings) => {
      await tool.execute("repair-update", {
        action: "update",
        jobId,
        job: { payload: { toolsAllow: ["browser", "sheets_append", "read"] } },
      });
      expect(calls).toEqual([
        ["cron.get", { id: jobId }],
        [
          "cron.update",
          {
            id: jobId,
            expectedConfigRevision: configRevision,
            patch: {
              payload: {
                kind: "agentTurn",
                toolsAllow: ["browser", "google_workspace__sheets_append", "read"],
              },
            },
          },
        ],
      ]);
      // The update carries the lent MCP tool's identity, so its scheduled runs can bind it.
      expect(bindings.get("cron.update")).toEqual([
        {
          name: "google_workspace__sheets_append",
          serverName: "google_workspace",
          operation: "tool",
          toolName: "sheets_append",
        },
      ]);
    });
  });

  it("refuses tools the conversation lacks and the automation control plane", async () => {
    await withRepairTool(async (tool, calls) => {
      await expect(
        tool.execute("repair-exec", {
          action: "update",
          jobId,
          job: { payload: { toolsAllow: ["browser", "exec"] } },
        }),
      ).rejects.toThrow(/Not available in this conversation.*: exec\./u);
      await expect(
        tool.execute("repair-automations", {
          action: "update",
          jobId,
          job: { payload: { toolsAllow: ["browser", "automations"] } },
        }),
      ).rejects.toThrow(/cannot get them: automations\./u);
      expect(calls.map(([method]) => method)).toEqual(["cron.get", "cron.get"]);
    });
  });

  it("can pause or run only its own job and change nothing else", async () => {
    await withRepairTool(async (tool, calls) => {
      await tool.execute("repair-pause", { action: "update", jobId, job: { enabled: false } });
      await tool.execute("repair-run", { action: "run", jobId, runMode: "force" });
      await expect(
        tool.execute("repair-other", { action: "get", jobId: "another-job" }),
      ).rejects.toThrow(`only get, update, or run automation ${jobId}`);
      await expect(tool.execute("repair-remove", { action: "remove", jobId })).rejects.toThrow(
        `only get, update, or run automation ${jobId}`,
      );
      await expect(
        tool.execute("repair-schedule", {
          action: "update",
          jobId,
          job: { schedule: { kind: "every", everyMs: 60_000 } },
        }),
      ).rejects.toThrow("A repair can change only payload.toolsAllow, or set enabled:false.");
      expect(calls).toEqual([
        ["cron.update", { id: jobId, patch: { enabled: false } }],
        ["cron.run", expect.objectContaining({ id: jobId, mode: "force" })],
      ]);
    });
  });
});

describe("cron next_check action", () => {
  const RUN_ID = "paced-run";
  const JOB_ID = "paced-job";
  let runClaimId: string | undefined;

  afterEach(() => {
    releaseAgentRunContext(RUN_ID, runClaimId);
    clearAgentRunContext(RUN_ID);
    runClaimId = undefined;
  });

  function createScopedTool(scopedJobId = JOB_ID) {
    return createCronTool(
      { selfRemoveOnlyJobId: scopedJobId, runId: RUN_ID },
      { callGatewayTool: vi.fn() },
    );
  }

  function registerRun(nextCheckEnabled: boolean) {
    runClaimId = claimAgentRunContext(
      RUN_ID,
      {
        sessionKey: `agent:main:cron:${JOB_ID}`,
        cronRunsByJobId: new Map([[JOB_ID, { nextCheckEnabled }]]),
      },
      { trackOwner: true, ownsContext: true },
    );
  }

  it("rejects a proposal when the current job does not admit next_check", async () => {
    registerRun(false);

    await expect(
      createScopedTool().execute("call-next-check", { action: "next_check", in: "15m" }),
    ).rejects.toThrow("cron next_check requires pacing or a one-shot session continuation");
  });

  it("rejects next_check outside a current cron run", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: vi.fn() });

    await expect(
      tool.execute("call-next-check-unscoped", { action: "next_check", in: "15m" }),
    ).rejects.toThrow("cron next_check is only available to the currently running job");
  });

  it("keeps proposals isolated when a shared run context adds another job", async () => {
    registerRun(true);
    await createScopedTool().execute("call-next-check-stale", {
      action: "next_check",
      in: "15m",
    });

    claimAgentRunContext(RUN_ID, {
      cronRunsByJobId: new Map([["next-job", { nextCheckEnabled: true }]]),
    });
    await createScopedTool("next-job").execute("call-next-check-next-job", {
      action: "next_check",
      in: "30m",
    });

    expect(consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBe(15 * 60_000);
    expect(consumeCronNextCheckProposal(RUN_ID, "next-job")).toBe(30 * 60_000);
  });
});
