import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import type { SessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { testing as resolverTesting } from "./mcp-connection-resolver.js";

vi.mock("./agent-bundle-mcp-runtime.js", () => {
  throw new Error("Lifecycle-only MCP work must not import the transport runtime");
});

const managers: SessionMcpRuntimeManager[] = [];
const params = {
  sessionId: "lifecycle-session",
  sessionKey: "agent:test:lifecycle-session",
  workspaceDir: "/workspace",
  agentDir: "/agents/test",
  cfg: { mcp: { servers: {} } },
  manifestRegistry: { plugins: [] },
};

function createRuntimeFixture(input: Parameters<CreateSessionMcpRuntime>[0]): SessionMcpRuntime {
  let lastUsedAt = Date.now();
  let activeLeases = 0;
  return {
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    workspaceDir: input.workspaceDir,
    agentDir: input.agentDir,
    requesterScope: input.requesterScope,
    configFingerprint: input.configFingerprint ?? "fixture",
    createdAt: lastUsedAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease() {
      activeLeases += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          activeLeases -= 1;
        }
      };
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
    peekCatalog: () => null,
    callTool: async () => ({ content: [] }),
    joinCleanup: async () => {},
    dispose: vi.fn(async () => {}),
  };
}

afterEach(async () => {
  resolverTesting.setMcpServerConnectionResolversForTest(undefined);
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
});

/** A requester's MCP connection is re-resolved after the turn it serves, past the window. */
describe("MCP requester connection revalidation", () => {
  it("serves the installed runtime at once past the window and re-resolves after the turn", async () => {
    let answer: "ok" | "throw" | "none" | "hold" = "ok";
    let issued = 0;
    let releaseHeld: (() => void) | undefined;
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "scoped",
        requiresRequesterIdentity: false,
        resolve: async () => {
          if (answer === "hold") {
            await new Promise<void>((resolve) => {
              releaseHeld = resolve;
            });
          }
          if (answer === "throw") {
            throw new Error("host restarting");
          }
          return answer === "none"
            ? null
            : {
                url: "https://mcp.example.test/scoped",
                headers: { authorization: `Bearer issued-${++issued}` },
              };
        },
      },
    ]);
    const gatewayClock = createGatewaySchedulerClock(1_000_000);
    const createRuntime = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createSessionMcpRuntimeManager({
      createRuntime,
      scheduler: createTestGatewayScheduler(gatewayClock.clock),
    });
    managers.push(manager);
    // Each turn comes past the revalidation window, as a Claude Code turn a minute later does.
    const acquire = async () => {
      await gatewayClock.advanceBy(61_000);
      return await manager.getOrCreateRequesterScoped({
        ...params,
        agentId: "main",
        cfg: { mcp: { servers: { scoped: { transport: "streamable-http" as const } } } },
      });
    };
    const first = expectDefined(await acquire(), "first runtime").runtime;
    // A slow resolver never holds the turn: the installed runtime answers at once.
    answer = "hold";
    expect(expectDefined(await acquire(), "served at once").runtime).toBe(first);
    answer = "ok";
    await vi.waitFor(() => expect(releaseHeld).toBeDefined());
    expectDefined(releaseHeld, "background resolution started")();
    // The resolver fails for a moment: the same runtime keeps serving (#238).
    answer = "throw";
    expect(expectDefined(await acquire(), "kept runtime").runtime).toBe(first);
    expect(expectDefined(await acquire(), "kept again").runtime).toBe(first);
    expect(first.dispose).not.toHaveBeenCalled();
    // A revocation applies from the next turn on.
    answer = "none";
    expect(await acquire()).toBeDefined();
    expect(await acquire()).toBeUndefined();
  });

  it("does not bring back a runtime for a session disposed before its revalidation runs", async () => {
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "scoped",
        requiresRequesterIdentity: false,
        resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
      },
    ]);
    const gatewayClock = createGatewaySchedulerClock(1_000_000);
    const createRuntime = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createSessionMcpRuntimeManager({
      createRuntime,
      scheduler: createTestGatewayScheduler(gatewayClock.clock),
    });
    managers.push(manager);
    const scoped = {
      ...params,
      agentId: "main",
      cfg: { mcp: { servers: { scoped: { transport: "streamable-http" as const } } } },
    };
    expectDefined(await manager.getOrCreateRequesterScoped(scoped), "first runtime");
    await gatewayClock.advanceBy(61_000);
    // The served turn queues its revalidation; a disposal queued alongside wins.
    const served = manager.getOrCreateRequesterScoped(scoped);
    const disposed = manager.disposeSession(params.sessionId);
    await served;
    await disposed;
    // Queued behind the revalidation on the same key, so that job has settled.
    await manager.disposeSession(params.sessionId);
    expect(manager.listSessionIds()).toEqual([]);
    expect(createRuntime).toHaveBeenCalledOnce();
  });

  it("drops a failing server once its failure outlasts the keep window", async () => {
    let answer: "ok" | "throw" = "ok";
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "scoped",
        requiresRequesterIdentity: false,
        resolve: async () => {
          if (answer === "throw") {
            throw new Error("host restarting");
          }
          return { url: "https://mcp.example.test/scoped" };
        },
      },
    ]);
    const gatewayClock = createGatewaySchedulerClock(1_000_000);
    const manager = createSessionMcpRuntimeManager({
      createRuntime: vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture),
      scheduler: createTestGatewayScheduler(gatewayClock.clock),
    });
    managers.push(manager);
    const acquire = async () => {
      await gatewayClock.advanceBy(61_000);
      return await manager.getOrCreateRequesterScoped({
        ...params,
        agentId: "main",
        cfg: { mcp: { servers: { scoped: { transport: "streamable-http" as const } } } },
      });
    };
    const first = expectDefined(await acquire(), "first runtime").runtime;
    answer = "throw";
    let turns = 0;
    while ((await acquire()) !== undefined) {
      turns += 1;
      expect(turns).toBeLessThan(10);
    }
    // Kept past the first failure, dropped after the 5-minute window (61 s per turn).
    expect(turns).toBeGreaterThanOrEqual(5);
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it("revokes instead of keeping when a sibling server answers unavailable during a failure", async () => {
    let siblingGone = false;
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "flaky",
        requiresRequesterIdentity: false,
        resolve: async () => {
          if (siblingGone) {
            throw new Error("host restarting");
          }
          return { url: "https://mcp.example.test/flaky" };
        },
      },
      {
        serverName: "revoked",
        requiresRequesterIdentity: false,
        resolve: async () => (siblingGone ? null : { url: "https://mcp.example.test/revoked" }),
      },
    ]);
    const gatewayClock = createGatewaySchedulerClock(1_000_000);
    const manager = createSessionMcpRuntimeManager({
      createRuntime: vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture),
      scheduler: createTestGatewayScheduler(gatewayClock.clock),
    });
    managers.push(manager);
    const servers = {
      flaky: { transport: "streamable-http" as const },
      revoked: { transport: "streamable-http" as const },
    };
    const acquire = async () => {
      await gatewayClock.advanceBy(61_000);
      return await manager.getOrCreateRequesterScoped({
        ...params,
        agentId: "main",
        cfg: { mcp: { servers } },
      });
    };
    const first = expectDefined(await acquire(), "first runtime").runtime;
    siblingGone = true;
    // The turn that finds the revocation is served; the next one sees it.
    expect(await acquire()).toBeDefined();
    expect(await acquire()).toBeUndefined();
    expect(first.dispose).toHaveBeenCalledOnce();
  });
});
