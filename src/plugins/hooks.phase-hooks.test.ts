import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { readToolAllowlistIntersection } from "../agents/tool-policy.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withClaimingHookAdmission } from "./hook-claim-admission.js";
import type { PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import {
  addStaticTestHooks,
  createMockPluginRegistry,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "./types.js";

type PromptHook = Pick<
  PluginHookRegistration<"before_prompt_build">,
  "handler" | "requiresToolAuthority" | "priority" | "afterEarlierHandlers" | "timeoutMs"
>;
const phaseEvent = { prompt: "test", messages: [] };
function promptRunner(hooks: PromptHook[]) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push(
    ...hooks.map((hook) => ({
      pluginId: "test",
      hookName: "before_prompt_build" as const,
      source: "test",
      ...hook,
    })),
  );
  return createHookRunner(registry);
}
const authority = {
  toolAuthorityFingerprint: "turn-authority",
  activeToolNames: ["message"],
  assertHostActive: () => undefined,
};

describe("prompt phase hooks", () => {
  it("merges context in priority order while keeping the first system prompt", async () => {
    const context = (suffix: string): PluginHookBeforePromptBuildResult => ({
      systemPrompt: `system ${suffix}`,
      prependContext: `context ${suffix}`,
      prependSystemContext: `prepend ${suffix}`,
      appendSystemContext: `append ${suffix}`,
    });
    const runner = promptRunner([
      { priority: 1, handler: () => context("B") },
      { priority: 10, handler: () => context("A") },
    ]);
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).resolves.toStrictEqual({
      systemPrompt: "system A",
      prependContext: "context A\n\ncontext B",
      appendContext: undefined,
      prependSystemContext: "prepend A\n\nprepend B",
      appendSystemContext: "append A\n\nappend B",
    });
  });

  it.each([
    { name: "explicit empty", toolsAllow: [] },
    { name: "non-array", toolsAllow: null as unknown as string[] },
    { name: "mixed-type array", toolsAllow: ["*", null] as unknown as string[] },
  ])("keeps $name tool restrictions closed", async ({ toolsAllow }) => {
    const runner = promptRunner([
      { handler: () => ({ toolsAllow }) },
      { handler: () => ({ toolsAllow: ["read"] }) },
    ]);
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).resolves.toStrictEqual({
      systemPrompt: undefined,
      prependContext: undefined,
      appendContext: undefined,
      prependSystemContext: undefined,
      appendSystemContext: undefined,
      toolsAllow: [],
    });
  });

  it("preserves overlapping frozen restrictions for the concrete tool surface", async () => {
    const runner = promptRunner([
      {
        handler: () => ({
          toolsAllow: Object.freeze(["group:fs", "web_*"]) as unknown as string[],
        }),
      },
      { handler: () => ({ toolsAllow: ["read", "*_search"] }) },
    ]);
    const toolsAllow = (await runner.runBeforePromptBuild(phaseEvent, {}))?.toolsAllow;
    expect(toolsAllow).toBeDefined();
    expect(readToolAllowlistIntersection(toolsAllow ?? [])).toEqual([
      ["group:fs", "web_*"],
      ["read", "*_search"],
    ]);
    expect(
      applyEmbeddedAttemptToolsAllow(
        [
          { name: "read" },
          { name: "web_search" },
          { name: "web_fetch" },
          { name: "memory_search" },
        ],
        toolsAllow,
      ),
    ).toEqual([{ name: "read" }, { name: "web_search" }]);
  });

  it("enriches only after host authorization and expires the supplied authority", async () => {
    const enrichment = vi.fn<PromptHook["handler"]>((_event, ctx) => {
      expect(ctx.toolAuthority?.allows("memory_search")).toBe(false);
      expect(ctx.toolAuthority?.allows("message")).toBe(true);
      return { prependContext: "authorized context", systemPrompt: "ignored override" };
    });
    const runner = promptRunner([
      { handler: () => ({ toolsAllow: ["message"] }) },
      { requiresToolAuthority: true, handler: enrichment },
    ]);
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).resolves.toMatchObject({
      toolsAllow: ["message"],
    });
    expect(enrichment).not.toHaveBeenCalled();
    await expect(runner.runAuthorizedPromptBuild(phaseEvent, {}, authority)).resolves.toEqual({
      prependContext: "authorized context",
    });
    const retained = enrichment.mock.calls[0]?.[1].toolAuthority;
    expect(() => retained?.assertActive()).toThrow("no longer active");
  });

  it.each([
    { name: "a concurrent sibling", afterEarlierHandlers: undefined },
    { name: "a waiting successor", afterEarlierHandlers: true as const },
  ])("rejects stale enrichment with $name after host authority closes", async (params) => {
    const started = createDeferred();
    const gate = createDeferred();
    const later = vi.fn(() => ({ prependContext: "later context" }));
    const runner = promptRunner([
      {
        requiresToolAuthority: true,
        handler: async () => {
          started.resolve();
          await gate.promise;
          return { prependContext: "stale context" };
        },
      },
      {
        requiresToolAuthority: true,
        handler: later,
        ...(params.afterEarlierHandlers ? { afterEarlierHandlers: true } : {}),
      },
    ]);
    let active = true;
    const run = runner.runAuthorizedPromptBuild(
      phaseEvent,
      {},
      {
        ...authority,
        assertHostActive: () => {
          if (!active) {
            throw new Error("host turn authority is no longer active");
          }
        },
      },
    );
    await started.promise;
    active = false;
    gate.resolve();
    await expect(run).rejects.toThrow("host turn authority is no longer active");
    // A sibling started with the dispatch; a waiting handler never starts once it closed.
    expect(later).toHaveBeenCalledTimes(params.afterEarlierHandlers ? 0 : 1);
  });
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("prompt hooks run together", () => {
  it("takes as long as the slowest handler and merges in priority order", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const settled: string[] = [];
      const slow = (name: string, ms: number) => async () => {
        await sleep(ms);
        settled.push(name);
        return { prependContext: name, appendSystemContext: `system ${name}` };
      };
      const runner = promptRunner([
        { priority: 10, handler: slow("C", 200) },
        { priority: 30, handler: slow("A", 300) },
        { priority: 20, handler: slow("B", 100) },
      ]);
      let done = false;
      const run = runner.runBeforePromptBuild(phaseEvent, {}).finally(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toEqual(["B", "C"]);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toMatchObject({
        prependContext: "A\n\nB\n\nC",
        appendSystemContext: "system A\n\nsystem B\n\nsystem C",
      });
      expect(settled).toEqual(["B", "C", "A"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs each handler's synchronous start in priority order before any awaited work", async () => {
    const entered: string[] = [];
    const reads = new Map<string, Promise<string>>();
    const gate = createDeferred();
    const runner = promptRunner([
      {
        priority: 1,
        handler: async () => {
          entered.push("reader");
          // The preload pattern: a later handler takes a read an earlier one started.
          const read = reads.get("setup");
          return read ? { appendContext: await read } : undefined;
        },
      },
      {
        priority: 1000,
        handler: () => {
          entered.push("preload");
          reads.set(
            "setup",
            gate.promise.then(() => "preloaded"),
          );
          return undefined;
        },
      },
      {
        priority: 500,
        handler: async () => {
          entered.push("middle");
          await gate.promise;
          return undefined;
        },
      },
    ]);
    const run = runner.runBeforePromptBuild(phaseEvent, {});
    expect(entered).toEqual(["preload", "middle", "reader"]);
    gate.resolve();
    await expect(run).resolves.toMatchObject({ appendContext: "preloaded" });
  });

  it("keeps the other results when one handler throws and another times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const registry = createEmptyPluginRegistry();
      const hook = (
        pluginId: string,
        priority: number,
        handler: PromptHook["handler"],
        timeoutMs?: number,
      ) => ({
        pluginId,
        hookName: "before_prompt_build" as const,
        source: "test",
        priority,
        handler,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      registry.typedHooks.push(
        hook("hung", 30, () => new Promise(() => {}), 50),
        hook("broken", 20, async () => {
          await sleep(10);
          throw new Error("synthetic failure");
        }),
        hook("healthy", 10, async () => {
          await sleep(20);
          return { appendContext: "healthy context" };
        }),
      );
      const run = createHookRunner(registry, { logger }).runBeforePromptBuild(phaseEvent, {});
      await vi.advanceTimersByTimeAsync(50);
      await expect(run).resolves.toMatchObject({ appendContext: "healthy context" });
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls.map(([message]) => message)).toEqual([
        expect.stringContaining("before_prompt_build handler from broken failed"),
        expect.stringContaining("before_prompt_build handler from hung failed"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns no result and closes running siblings when a fail-closed handler throws", async () => {
    const registry = createEmptyPluginRegistry();
    const gate = createDeferred();
    let siblingContext: PluginHookAgentContext | undefined;
    registry.typedHooks.push(
      {
        pluginId: "sibling",
        hookName: "before_prompt_build",
        source: "test",
        priority: 10,
        handler: async (_event, ctx) => {
          siblingContext = ctx;
          await gate.promise;
          return { appendContext: "late" };
        },
      },
      {
        pluginId: "strict",
        hookName: "before_prompt_build",
        source: "test",
        priority: 1,
        handler: async () => {
          throw new Error("synthetic strict failure");
        },
      },
    );
    const runner = createHookRunner(registry, { catchErrors: false });
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).rejects.toThrow(
      "before_prompt_build handler from strict failed",
    );
    expect(isActive(siblingContext?.hookInvocation)).toBe(false);
    gate.resolve();
  });

  it("drops the merged result when claim admission is revoked while handlers run", async () => {
    const gate = createDeferred();
    let current = true;
    const runner = promptRunner([
      {
        handler: async () => {
          await gate.promise;
          return { appendContext: "context" };
        },
      },
      { handler: () => ({ prependContext: "fast" }) },
    ]);
    const context = withClaimingHookAdmission(
      {},
      {
        assertCurrent: () => {
          if (!current) {
            throw new Error("admission revoked");
          }
        },
      },
    );
    const run = runner.runBeforePromptBuild(phaseEvent, context);
    await Promise.resolve();
    current = false;
    gate.resolve();
    await expect(run).rejects.toThrow("admission revoked");
  });

  it("starts a waiting handler only after every earlier handler settles, timed out ones included", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const entered: string[] = [];
      const runner = promptRunner([
        {
          priority: 30,
          timeoutMs: 100,
          handler: () => {
            entered.push("hung");
            return new Promise(() => {});
          },
        },
        {
          priority: 20,
          handler: async () => {
            entered.push("earlier");
            await sleep(40);
            return { appendContext: "earlier" };
          },
        },
        {
          priority: 10,
          afterEarlierHandlers: true,
          // Its own budget counts from its start, not from the dispatch.
          timeoutMs: 30,
          handler: async () => {
            entered.push("waiting");
            await sleep(20);
            return { appendContext: "waiting" };
          },
        },
        {
          priority: 0,
          handler: () => {
            entered.push("later");
            return { appendContext: "later" };
          },
        },
      ]);
      const run = runner.runBeforePromptBuild(phaseEvent, {});
      expect(entered).toEqual(["hung", "earlier", "later"]);
      await vi.advanceTimersByTimeAsync(99);
      expect(entered).toEqual(["hung", "earlier", "later"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(entered).toEqual(["hung", "earlier", "later", "waiting"]);
      await vi.advanceTimersByTimeAsync(20);
      await expect(run).resolves.toMatchObject({ appendContext: "earlier\n\nwaiting\n\nlater" });
    } finally {
      vi.useRealTimers();
    }
  });
});

type PromptPhase = "ordinary" | "authorized";
type Invocation = PluginHookAgentContext["hookInvocation"];

function isActive(invocation: Invocation): boolean | undefined {
  if (!invocation) {
    return undefined;
  }
  try {
    invocation.assertActive();
    return true;
  } catch {
    return false;
  }
}

function createRunner(
  phase: PromptPhase,
  hooks: PluginHookRegistration<"before_prompt_build">[],
  logger: { warn: (message: string) => void; error: (message: string) => void },
) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push(
    ...hooks.map((hook) => ({
      ...hook,
      ...(phase === "authorized" ? { requiresToolAuthority: true as const } : {}),
    })),
  );
  return createHookRunner(registry, {
    logger,
    modifyingHookTimeoutMsByHook: { before_prompt_build: 100 },
  });
}

function dispatch(
  runner: ReturnType<typeof createHookRunner>,
  phase: PromptPhase,
  context: PluginHookAgentContext,
) {
  const event = { prompt: "synthetic prompt", messages: [] };
  return phase === "ordinary"
    ? runner.runBeforePromptBuild(event, context)
    : runner.runAuthorizedPromptBuild(event, context, {
        toolAuthorityFingerprint: "synthetic-turn-authority",
        activeToolNames: ["memory_search"],
        assertHostActive: () => undefined,
      });
}

describe("prompt hook invocation", () => {
  it.each([
    { phase: "ordinary", outcome: "returned" },
    { phase: "ordinary", outcome: "threw" },
    { phase: "authorized", outcome: "rejected" },
  ] as const)(
    "revokes a $phase $outcome handler before result merging or error handling",
    async ({ phase, outcome }) => {
      const context = Object.freeze({ agentId: "test-agent", sessionKey: "test-session" });
      let handlerContext: PluginHookAgentContext = {};
      let activeOnEntry: boolean | undefined;
      const activeAtMerge: Array<boolean | undefined> = [];
      const activeAtError: Array<boolean | undefined> = [];
      const logger = {
        warn: vi.fn(),
        error: vi.fn(() => {
          activeAtError.push(isActive(handlerContext.hookInvocation));
        }),
      };
      const runner = createRunner(
        phase,
        [
          {
            pluginId: "settling-handler",
            hookName: "before_prompt_build",
            source: "test",
            handler: (_event, ctx) => {
              handlerContext = ctx;
              activeOnEntry = isActive(ctx.hookInvocation);
              const failure = new Error("synthetic handler failure");
              if (outcome === "threw") {
                throw failure;
              }
              if (outcome === "rejected") {
                return Promise.reject(failure);
              }
              return {
                get prependContext() {
                  activeAtMerge.push(isActive(ctx.hookInvocation));
                  return "timely context";
                },
              };
            },
          },
        ],
        logger,
      );
      expect(await dispatch(runner, phase, context)).toEqual(
        outcome === "returned" ? { prependContext: "timely context" } : undefined,
      );
      expect(activeOnEntry).toBe(true);
      expect(handlerContext).not.toBe(context);
      expect(context).toEqual({ agentId: "test-agent", sessionKey: "test-session" });
      expect(context).not.toHaveProperty("hookInvocation");
      expect(isActive(handlerContext.hookInvocation)).toBe(false);
      if (outcome === "returned") {
        expect(activeAtMerge.length).toBeGreaterThan(0);
        expect(activeAtMerge.every((active) => active === false)).toBe(true);
        expect(activeAtError).toEqual([]);
      } else {
        expect(activeAtMerge).toEqual([]);
        expect(activeAtError).toEqual([false]);
      }
    },
  );

  it.each(["ordinary", "authorized"] as const)(
    "expires only the timed-out %s handler while its concurrent sibling is still active",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const firstGate = createDeferredCore();
      const secondGate = createDeferredCore();
      const pending: Promise<unknown>[] = [];
      const contexts: PluginHookAgentContext[] = [];
      const context = Object.freeze({ agentId: "test-agent" });
      let firstResumed = false;
      let firstActiveAtSecondEntry: boolean | undefined;
      const activeAtTimeout: Array<boolean | undefined> = [];
      const logger = {
        warn: vi.fn(),
        error: vi.fn(() => {
          activeAtTimeout.push(isActive(contexts[0]?.hookInvocation));
        }),
      };
      const runner = createRunner(
        phase,
        [
          {
            pluginId: "timed-out-handler",
            hookName: "before_prompt_build",
            source: "test",
            timeoutMs: 5,
            handler: (_event, ctx) => {
              contexts.push(ctx);
              const work = firstGate.promise.then(() => {
                firstResumed = true;
                return { prependContext: "discarded late context" };
              });
              pending.push(work);
              return work;
            },
          },
          {
            pluginId: "live-sibling",
            hookName: "before_prompt_build",
            source: "test",
            handler: (_event, ctx) => {
              firstActiveAtSecondEntry = isActive(contexts[0]?.hookInvocation);
              contexts.push(ctx);
              const work = secondGate.promise.then(() => ({ prependContext: "live context" }));
              pending.push(work);
              return work;
            },
          },
        ],
        logger,
      );
      const run = dispatch(runner, phase, context);
      try {
        // Both start with the dispatch, in priority order.
        expect(contexts).toHaveLength(2);
        expect(firstActiveAtSecondEntry).toBe(true);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(true);
        await vi.advanceTimersByTimeAsync(5);
        expect(activeAtTimeout).toEqual([false]);
        expect(contexts[0]?.hookInvocation).not.toBe(contexts[1]?.hookInvocation);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(false);
        expect(isActive(contexts[1]?.hookInvocation)).toBe(true);
        expect(context).not.toHaveProperty("hookInvocation");
        expect(firstResumed).toBe(false);

        firstGate.resolve();
        await Promise.allSettled(pending.slice(0, 1));
        expect(firstResumed).toBe(true);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(false);
        expect(isActive(contexts[1]?.hookInvocation)).toBe(true);
        secondGate.resolve();
        await expect(run).resolves.toEqual({ prependContext: "live context" });
        expect(isActive(contexts[1]?.hookInvocation)).toBe(false);
      } finally {
        firstGate.resolve();
        secondGate.resolve();
        try {
          await Promise.allSettled([...pending, run]);
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );
});

const promptEvent = (prompt: string) => ({ prompt, messages: [] });

describe("before_prompt_build reentrancy", () => {
  it("runs each handler once when a handler starts a nested prompt build", async () => {
    const firstHandler = vi.fn(async () => {
      await runner.runBeforePromptBuild(promptEvent("nested"), TEST_PLUGIN_AGENT_CTX);
      return { prependContext: "first" };
    });
    const secondHandler = vi.fn(() => ({ appendContext: "second" }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: firstHandler,
          pluginId: "first",
          priority: 10,
        },
        {
          hookName: "before_prompt_build",
          handler: secondHandler,
          pluginId: "second",
          priority: 1,
        },
      ]),
    );

    await expect(
      runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX),
    ).resolves.toEqual({
      systemPrompt: undefined,
      prependContext: "first",
      appendContext: "second",
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it("keeps sibling hook families and other runners active during dispatch", async () => {
    const turnPrepare = vi.fn(() => ({ prependContext: "turn" }));
    const heartbeat = vi.fn(() => ({ appendContext: "heartbeat" }));
    const otherPromptBuild = vi.fn(() => ({ prependContext: "other runner" }));
    const otherRunner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: otherPromptBuild,
          pluginId: "other",
        },
      ]),
    );
    const promptBuild = vi.fn(async () => {
      await runner.runAgentTurnPrepare(
        { prompt: "nested", messages: [], queuedInjections: [] },
        TEST_PLUGIN_AGENT_CTX,
      );
      await runner.runHeartbeatPromptContribution(
        { heartbeatName: "heartbeat" },
        TEST_PLUGIN_AGENT_CTX,
      );
      await otherRunner.runBeforePromptBuild(promptEvent("nested"), TEST_PLUGIN_AGENT_CTX);
      return {};
    });
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: promptBuild,
          pluginId: "prompt",
        },
        {
          hookName: "agent_turn_prepare",
          handler: turnPrepare,
          pluginId: "turn",
        },
        {
          hookName: "heartbeat_prompt_contribution",
          handler: heartbeat,
          pluginId: "heartbeat",
        },
      ]),
    );

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);

    expect(promptBuild).toHaveBeenCalledOnce();
    expect(turnPrepare).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(otherPromptBuild).toHaveBeenCalledOnce();
  });

  it("allows detached descendants to dispatch after the outer call settles", async () => {
    let releaseDetached: (() => void) | undefined;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedDispatch: Promise<unknown> | undefined;
    const promptBuild = vi.fn(async (event: unknown) => {
      const prompt = (event as { prompt: string }).prompt;
      if (prompt === "outer") {
        detachedDispatch = (async () => {
          await detachedGate;
          return await runner.runBeforePromptBuild(promptEvent("detached"), TEST_PLUGIN_AGENT_CTX);
        })();
      }
      return { prependContext: prompt };
    });
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: promptBuild,
          pluginId: "prompt",
        },
      ]),
    );

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);
    releaseDetached?.();
    const pendingDetachedDispatch = detachedDispatch;
    if (!pendingDetachedDispatch) {
      throw new Error("detached prompt dispatch was not created");
    }
    await expect(pendingDetachedDispatch).resolves.toEqual({
      systemPrompt: undefined,
      prependContext: "detached",
      appendContext: undefined,
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
    expect(promptBuild).toHaveBeenCalledTimes(2);
  });
});

const finalizeEvent = {
  runId: "run-1",
  sessionId: "session-1",
  stopHookActive: false,
  lastAssistantMessage: "done",
};
function finalize(...results: PluginHookBeforeAgentFinalizeResult[]) {
  return createHookRunner(
    createMockPluginRegistry(
      results.map((result) => ({
        hookName: "before_agent_finalize",
        handler: () => result,
      })),
    ),
  ).runBeforeAgentFinalize(finalizeEvent, TEST_PLUGIN_AGENT_CTX);
}

describe("before_agent_finalize", () => {
  it("retains valid retry candidates in order while discarding invalid instructions", async () => {
    const result = await finalize(
      { action: "revise", reason: "empty", retry: { instruction: "   ", idempotencyKey: "empty" } },
      {
        action: "revise",
        reason: "malformed",
        retry: { instruction: 123, idempotencyKey: "bad" } as never,
      },
      {
        action: "revise",
        reason: "artifacts",
        retry: {
          instruction: " regenerate artifacts ",
          idempotencyKey: "artifacts",
          maxAttempts: 1,
        },
      },
      {
        action: "revise",
        reason: "tests",
        retry: { instruction: "rerun tests", idempotencyKey: "tests", maxAttempts: 1 },
      },
    );
    expect(result).toEqual({
      action: "revise",
      reason: "empty\n\nmalformed\n\nartifacts\n\ntests",
      retry: { instruction: "regenerate artifacts", idempotencyKey: "artifacts", maxAttempts: 1 },
    });
    expect(Object.getOwnPropertyDescriptor(result, "retryCandidates")).toMatchObject({
      enumerable: false,
      value: [
        { instruction: "regenerate artifacts", idempotencyKey: "artifacts", maxAttempts: 1 },
        { instruction: "rerun tests", idempotencyKey: "tests", maxAttempts: 1 },
      ],
    });
  });

  it("lets finalize override revise decisions", async () => {
    await expect(
      finalize(
        { action: "revise", reason: "keep going" },
        { action: "finalize", reason: "enough" },
      ),
    ).resolves.toEqual({ action: "finalize", reason: "enough" });
  });

  it("bounds hung handlers so the original final answer can proceed", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const runner = createHookRunner(
        createMockPluginRegistry([
          { hookName: "before_agent_finalize", handler: () => new Promise(() => {}) },
        ]),
        { logger },
      );
      const run = runner.runBeforeAgentFinalize(finalizeEvent, TEST_PLUGIN_AGENT_CTX);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("timed out after 15000ms"));
    } finally {
      vi.useRealTimers();
    }
  });
});

it.each([
  { higher: [], lower: ["local/backup"], priority: 10, expected: [] },
  { higher: ["local/backup"], lower: [], priority: 10, expected: ["local/backup"] },
  { higher: undefined, lower: ["local/backup"], priority: 10, expected: ["local/backup"] },
  { higher: [], lower: ["local/first"], priority: 0, expected: ["local/first"] },
  { higher: null as unknown as string[], lower: ["local/backup"], priority: 10, expected: [] },
])(
  "keeps the first defined routing overrides after a broken plugin ($priority)",
  async ({ higher, lower, priority, expected }) => {
    const registry = createEmptyPluginRegistry();
    const broken = vi.fn(() => {
      throw new Error("plugin crashed");
    });
    addStaticTestHooks(registry, {
      hookName: "before_model_resolve",
      hooks: [
        {
          pluginId: "low",
          result: {
            modelOverride: "low-model",
            providerOverride: "low-provider",
            fallbacksOverride: lower,
          },
        },
        {
          pluginId: "broken",
          priority: 100,
          result: {},
          handler: broken,
        },
        {
          pluginId: "high",
          priority,
          result: {
            modelOverride: "high-model",
            providerOverride: "high-provider",
            fallbacksOverride: higher,
          },
        },
      ],
    });
    await expect(
      createHookRunner(registry).runBeforeModelResolve({ prompt: "test" }, TEST_PLUGIN_AGENT_CTX),
    ).resolves.toEqual({
      modelOverride: priority ? "high-model" : "low-model",
      providerOverride: priority ? "high-provider" : "low-provider",
      fallbacksOverride: expected,
    });
    expect(broken).toHaveBeenCalledOnce();
  },
);
