import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentToolActionDescriptor } from "../agents/agent-tool-metadata.js";
import type { PreparedPairedComputerUse } from "../agents/computer-use-node-capabilities.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import * as gatewayTools from "../agents/tools/gateway.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const cfg = { plugins: { enabled: false }, tools: { allow: ["computer", "message"] } };
const prepared: PreparedPairedComputerUse = {
  actions: ["screenshot", "list_windows", "launch_app"],
  gateway: { configured: false, available: false },
};

function resolve(overrides: Partial<Parameters<typeof resolveGatewayScopedTools>[0]> = {}) {
  return resolveGatewayScopedTools({
    cfg,
    sessionKey: "agent:main:telegram:direct:42",
    surface: "loopback",
    senderIsOwner: true,
    modelHasVision: true,
    messageProvider: "telegram",
    currentChannelId: "telegram:42",
    accountId: "account-1",
    ...overrides,
  });
}

/** What a node.list issued by the computer tool sees as its calling identity. */
async function observeCallerIdentity(tool: { execute: (...args: never[]) => unknown }) {
  let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
  vi.spyOn(gatewayTools, "callGatewayTool").mockImplementation(async (method: string) => {
    identity ??= getGatewayToolCallerIdentity();
    if (method === "node.list") {
      return { nodes: [] } as never;
    }
    return { configured: false, available: false } as never;
  });
  await Promise.resolve(
    (tool.execute as (id: string, args: unknown) => unknown)("call-1", {
      action: "screenshot",
      target: "node",
    }),
  ).catch(() => undefined);
  return identity;
}

describe("computer-only rebuild of a scoped catalog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRuntimeConfigSnapshot({});
  });

  it("matches a full build that was given the prepared paired-node surface", async () => {
    const scoped = await resolve();
    const full = await resolve({ pairedNodeComputerUse: prepared });
    const rebuiltTools = scoped.rebuildWithPairedComputerUse?.(prepared);

    expect(rebuiltTools).toBeDefined();
    expect(rebuiltTools?.map((tool) => tool.name)).toEqual(full.tools.map((tool) => tool.name));
    const rebuilt = rebuiltTools?.find((tool) => tool.name === "computer");
    const expected = full.tools.find((tool) => tool.name === "computer");
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(scoped.tools.find((tool) => tool.name === "computer"));
    expect(rebuilt?.description).toBe(expected?.description);
    expect(rebuilt?.parameters).toEqual(expected?.parameters);
    expect(rebuilt?.parameters).toMatchObject({
      properties: { action: { enum: expect.arrayContaining(["launch_app"]) } },
    });
    expect(getAgentToolActionDescriptor(rebuilt!)).toBeDefined();
    expect(getAgentToolActionDescriptor(rebuilt!)).toEqual(getAgentToolActionDescriptor(expected!));
    // Tools other than computer are the very ones the first build returned.
    for (const tool of rebuiltTools ?? []) {
      if (tool.name !== "computer") {
        expect(tool).toBe(scoped.tools.find((candidate) => candidate.name === tool.name));
      }
    }
  });

  it("carries the same gateway caller identity, turn source included", async () => {
    const scoped = await resolve();
    const full = await resolve({ pairedNodeComputerUse: prepared });
    const rebuilt = scoped
      .rebuildWithPairedComputerUse?.(prepared)
      ?.find((tool) => tool.name === "computer");
    const expected = full.tools.find((tool) => tool.name === "computer");

    const rebuiltIdentity = await observeCallerIdentity(rebuilt!);
    vi.restoreAllMocks();
    const expectedIdentity = await observeCallerIdentity(expected!);

    expect(expectedIdentity).toMatchObject({
      sessionKey: "agent:main:telegram:direct:42",
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:42",
      turnSourceAccountId: "account-1",
    });
    expect(rebuiltIdentity).toEqual(expectedIdentity);
  });

  it("offers no rebuild when policy removed computer", async () => {
    const scoped = await resolve({ cfg: { ...cfg, tools: { allow: ["message"] } } });

    expect(scoped.tools.some((tool) => tool.name === "computer")).toBe(false);
    expect(scoped.rebuildWithPairedComputerUse).toBeUndefined();
  });
});
