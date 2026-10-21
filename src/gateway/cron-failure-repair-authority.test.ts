// The scheduler's repair turn may fix its failing automation, and nothing else.
import { describe, expect, it } from "vitest";
import { resolveCronRepairToolsAllowProvenance } from "../cron/tools-allow-provenance.js";
import { assertCronFailureRepairRequest } from "./cron-creator-authority-grant.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "./server-methods/cron-creator-authority-admission.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

const repair = { source: "failure-repair", jobId: "job-1" } as const;
const provenance = {
  kind: "internal_system",
  sourceTool: "cron_failure_repair",
  jobId: "job-1",
} as const;

function admit(
  overrides: Partial<Parameters<typeof resolveGatewayCronCreatorAuthorityAdmission>[0]>,
) {
  return resolveGatewayCronCreatorAuthorityAdmission({
    runId: "repair-run",
    resolvedSessionKey: "agent:main:telegram:direct:owner",
    sessionId: "owner-session",
    request: {} as AgentRunRequest,
    client: createSyntheticPluginRuntimeClient({ cronFailureRepairJobId: "job-1" }),
    inputProvenance: provenance,
    hasRestoredCronContinuation: false,
    isOneShotModelRun: false,
    isRestartRecoveryResumeRun: false,
    ...overrides,
  });
}

describe("failure-repair automation authority", () => {
  it("admits only the scheduler's repair turn, bound to its job", () => {
    expect(admit({})).toMatchObject({
      runId: "repair-run",
      callerOrigin: { kind: "unknown" },
      managementEntitlement: repair,
    });
    // A provenance label without the scheduler's client is not authority.
    expect(admit({ client: createSyntheticPluginRuntimeClient() })).toBeUndefined();
    expect(admit({ inputProvenance: { ...provenance, jobId: "job-2" } })).toBeUndefined();
    expect(admit({ inputProvenance: { kind: "external_user" } })).toBeUndefined();
    expect(admit({ spawnedBy: "agent:main:telegram:direct:owner" })).toBeUndefined();
  });

  it("fences the repair grant to its job's tools and on/off state", () => {
    const check = (method: string, params: unknown, current?: string[]) => () =>
      assertCronFailureRepairRequest(repair, method, params, {
        kind: "agentTurn",
        toolsAllow: current,
      });
    const update = (patch: unknown) => ({ id: "job-1", patch });
    const tools = (toolsAllow: unknown[]) => update({ payload: { kind: "agentTurn", toolsAllow } });

    expect(check("cron.get", { id: "job-1" })).not.toThrow();
    expect(check("cron.run", { id: "job-1", mode: "force" })).not.toThrow();
    expect(check("cron.update", update({ enabled: false }))).not.toThrow();
    expect(
      check("cron.update", tools(["browser", "google_workspace__sheets_append"]), ["browser"]),
    ).not.toThrow();
    // A tool the job already had stays; the repair only cannot add it.
    expect(check("cron.update", tools(["automations", "browser"]), ["automations"])).not.toThrow();

    expect(check("cron.update", { id: "job-2", patch: { enabled: false } })).toThrow(
      "only job job-1 can be changed",
    );
    expect(check("cron.remove", { id: "job-1" })).toThrow("only get, update, and run");
    expect(check("cron.list", {})).toThrow("only get, update, and run");
    expect(check("cron.add", { job: {} })).toThrow("only get, update, and run");
    expect(check("cron.update", update({ enabled: true }))).toThrow("only payload.toolsAllow");
    expect(check("cron.update", update({ schedule: { kind: "every", everyMs: 1 } }))).toThrow(
      "only payload.toolsAllow",
    );
    expect(
      check("cron.update", update({ payload: { kind: "agentTurn", message: "new task" } })),
    ).toThrow("only payload.toolsAllow");
    expect(
      check("cron.update", update({ payload: { kind: "script", toolsAllow: ["browser"] } }), [
        "browser",
      ]),
    ).toThrow("only payload.toolsAllow");
    for (const broad of [
      "*",
      "group:fs",
      "automations",
      "cron",
      "gateway",
      "sessions",
      "terminal",
    ]) {
      expect(check("cron.update", tools(["browser", broad]), ["browser"])).toThrow(
        "cannot be added",
      );
    }
    // Other entitlements keep their own rules.
    expect(() =>
      assertCronFailureRepairRequest({ source: "control-ui-admin" }, "cron.remove", { id: "x" }),
    ).not.toThrow();
  });

  it("keeps a repaired job's requester facts and binds only names it lacks", () => {
    const binding = (name: string, serverName: string) =>
      ({ name, serverName, operation: "tool", toolName: name.split("__")[1]! }) as const;
    const mail = binding("mail__read", "mail");
    const sheets = binding("google_workspace__sheets_append", "google_workspace");
    const surface = {
      toolsAllowProvenance: {
        version: 1 as const,
        source: "final-executable-surface" as const,
        callerOrigin: { kind: "local" as const },
        mcpToolBindings: [mail],
      },
    };
    expect(
      resolveCronRepairToolsAllowProvenance({
        job: surface,
        toolsAllow: ["browser", mail.name, sheets.name],
        // A turn cannot rebind a name the job already has, or bind one it does not list.
        lentMcpToolBindings: [binding("mail__read", "other"), sheets, binding("x__y", "x")],
      }),
    ).toEqual({ ...surface.toolsAllowProvenance, mcpToolBindings: [mail, sheets] });

    const requester = {
      toolsAllowProvenance: {
        version: 1 as const,
        source: "authenticated-requester" as const,
        callerOrigin: { kind: "external" as const, channel: "telegram" },
      },
    };
    expect(
      resolveCronRepairToolsAllowProvenance({
        job: requester,
        toolsAllow: ["browser", "read"],
        lentMcpToolBindings: [],
      }),
    ).toEqual(requester.toolsAllowProvenance);
    expect(
      resolveCronRepairToolsAllowProvenance({
        job: {},
        toolsAllow: ["read"],
        lentMcpToolBindings: undefined,
      }),
    ).toBeUndefined();
  });
});
