import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { scheduleGatewayIdleTask, type GatewayIdleTaskHandle } from "./server-idle-task.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

const GATEWAY_HANDLER_PREWARM_RETRY_DELAY_MS = 250;

const PREWARMED_HANDLER_METHODS = ["chat.history", "chat.send", "sessions.list"];

type GatewayHandlerPrewarmItem = {
  name: string;
  notBeforeMs?: number;
  waitForIdle?: boolean;
  load: (isCancelled: () => boolean) => Promise<unknown>;
};

function handlerItem(method: string): GatewayHandlerPrewarmItem {
  return {
    name: method,
    // Module loads run detached so process-lifetime module state does not inherit this idle
    // task's async context; isCancelled stays outside because it reads that context.
    load: async (isCancelled) => {
      const [{ coreGatewayHandlers }, { prepareGatewayRequestHandler }] =
        await runInDetachedAsyncContext(() =>
          Promise.all([
            import("./server-methods/core-handlers.js"),
            import("./server-methods/lazy-core-handlers.js"),
          ]),
        );
      if (!isCancelled()) {
        const handler = coreGatewayHandlers[method];
        if (!handler) {
          throw new Error(`Gateway prewarm handler not found: ${method}`);
        }
        await runInDetachedAsyncContext(() => prepareGatewayRequestHandler(handler));
      }
    },
  };
}

// Module loads only. No step reads sessions, spawns, reaches the network or memoizes auth,
// PATH or version probes: a golden snapshot predates the per-boot PATH link. Each step is its
// own item so work admission can close between steps and each has a trace name.
function agentTurnModuleItems(): GatewayHandlerPrewarmItem[] {
  const step = (name: string, load: () => Promise<unknown>): GatewayHandlerPrewarmItem => ({
    name: `agent-turn.${name}`,
    load: async (isCancelled) => {
      if (!isCancelled()) {
        await runInDetachedAsyncContext(load);
      }
    },
  });
  const loaders = () => import("../agents/command/runtime-loaders.js");
  return [
    step("attempt-execution", async () => (await loaders()).loadAttemptExecutionRuntime()),
    step("delivery", async () => (await loaders()).loadDeliveryRuntime()),
    step("session-store", async () => (await loaders()).loadSessionStoreRuntime()),
    step("acp-manager", async () => (await loaders()).loadAcpManagerRuntime()),
    step("cli-compaction", async () => (await loaders()).loadCliCompactionRuntime()),
    step("skills", async () => (await loaders()).loadSkillsRuntime()),
    step("exec-defaults", async () => (await loaders()).loadExecDefaultsRuntime()),
    step("cli-deps", async () => (await loaders()).loadCliDepsRuntime()),
    step("cli-prepare", () => import("../agents/cli-runner/prepare.runtime.js")),
    step("cli-execute", () => import("../agents/cli-runner/execute.runtime.js")),
    step("acp-workspace", () => import("../agents/acp-workspace-provisioning.js")),
    step("model-catalog", () => import("../agents/model-catalog.runtime.js")),
    step("chat-commands", () => import("../skills/discovery/chat-commands.runtime.js")),
  ];
}

function gatewayPrewarmItems(getConfig: () => OpenClawConfig): GatewayHandlerPrewarmItem[] {
  return [
    {
      name: "session-history-worker",
      // Browser loading must not defer preparation of the worker its first history read needs.
      waitForIdle: false,
      load: async (isCancelled) => {
        const { prewarmGatewaySessionHistory } = await import("./server-history-prewarm.js");
        if (!isCancelled()) {
          await prewarmGatewaySessionHistory(getConfig(), { isCancelled });
        }
      },
    },
    // Agent turns first: a snapshot bake suspends the Gateway soon after readiness, and a
    // restored Gateway starts the first owner turn at once, so later items may never run.
    handlerItem("agent"),
    ...agentTurnModuleItems(),
    ...PREWARMED_HANDLER_METHODS.map(handlerItem),
    { name: "agent-events", load: () => import("./server-chat.js") },
    { name: "session-key", load: () => import("./server-session-key.js") },
    {
      name: "context-window-cache",
      notBeforeMs: 5_000,
      load: async (isCancelled) => {
        const { prewarmContextWindowCacheAfterReady } = await import("../agents/context.js");
        if (!isCancelled()) {
          await prewarmContextWindowCacheAfterReady({ config: getConfig(), isCancelled });
        }
      },
    },
    {
      name: "memory-search",
      load: async (isCancelled) => {
        const { getMemoryCapabilityRegistration } = await import("../plugins/memory-state.js");
        if (isCancelled() || getMemoryCapabilityRegistration()?.pluginId !== "memory-core") {
          return;
        }
        const { loadBundledPluginPublicArtifactModuleSync } =
          await import("../plugins/public-surface-loader.js");
        if (isCancelled()) {
          return;
        }
        const { prewarmMemorySearchWorker } = loadBundledPluginPublicArtifactModuleSync<{
          prewarmMemorySearchWorker: () => Promise<void>;
        }>({ dirName: "memory-core", artifactBasename: "prewarm-api.js" });
        await prewarmMemorySearchWorker();
      },
    },
    {
      name: "plugins",
      load: async (isCancelled) => {
        const { listManagedPlugins } = await import("../plugins/management-service.js");
        if (!isCancelled()) {
          await listManagedPlugins({ config: getConfig() });
        }
      },
    },
  ];
}

export function scheduleGatewayHandlerPrewarm(params: {
  scheduler: GatewayScheduler;
  getConfig: () => OpenClawConfig;
  startupTrace?: Pick<GatewayStartupTrace, "measure">;
  log: { warn: (msg: string) => void };
  items?: readonly GatewayHandlerPrewarmItem[];
  waitForPostReadyWork?: () => Promise<void>;
}): GatewayIdleTaskHandle {
  let stopped = false;
  const startedAt = params.scheduler.now();
  // Warm code and local facts without executing requests or acquiring live provider catalogs.
  const items = params.items ?? gatewayPrewarmItems(params.getConfig);
  let nextIndex = 0;
  let currentItemName = "unknown";
  let idleTask: GatewayIdleTaskHandle | undefined;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    if (nextIndex >= items.length) {
      return;
    }
    void (async () => {
      await params.waitForPostReadyWork?.();
      if (stopped) {
        return;
      }
      const item = items[nextIndex++];
      if (!item) {
        return;
      }
      currentItemName = item.name;
      const isBusy = () =>
        item.waitForIdle !== false && getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0;
      const load = () => item.load(() => stopped || isBusy());
      idleTask = scheduleGatewayIdleTask({
        id: "startup:handler-prewarm",
        scheduler: params.scheduler,
        delayMs: Math.max(0, (item.notBeforeMs ?? 0) - (params.scheduler.now() - startedAt)),
        retryDelayMs: GATEWAY_HANDLER_PREWARM_RETRY_DELAY_MS,
        isClosing: () => stopped,
        isBusy,
        run: async () => {
          try {
            await (params.startupTrace
              ? params.startupTrace.measure(`post-ready.gateway-data.${item.name}`, load)
              : load());
          } finally {
            // Keep the outgoing join published until its lease and warning handler settle.
            void Promise.resolve(idleTask?.stop()).then(scheduleNext, scheduleNext);
          }
        },
        log: params.log,
        // Prewarm only improves latency; readiness and request-time loaders remain authoritative.
        errorMessage: `post-ready gateway data prewarm failed for ${item.name}`,
      });
    })().catch((err: unknown) => {
      params.log.warn(
        `post-ready gateway data prewarm failed for ${currentItemName}: ${String(err)}`,
      );
      scheduleNext();
    });
  };

  // One cache fill per event-loop turn lets immediate client work run between steps.
  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      return idleTask?.stop();
    },
  };
}

export function scheduleGatewayPrewarm(
  params: Parameters<typeof scheduleGatewayHandlerPrewarm>[0],
): GatewayIdleTaskHandle[] {
  return [
    scheduleGatewayHandlerPrewarm(params),
    scheduleGatewayIdleTask({
      id: "startup:dependency-template-prewarm",
      scheduler: params.scheduler,
      delayMs: 0,
      retryDelayMs: GATEWAY_HANDLER_PREWARM_RETRY_DELAY_MS,
      isClosing: () => false,
      isBusy: () => false,
      run: async (signal) => {
        await racePromiseWithAbortSignal(
          params.waitForPostReadyWork?.() ?? Promise.resolve(),
          signal,
        );
        signal.throwIfAborted();
        const { prewarmLocalWorkspaceTemplates } =
          await import("./worker-environments/local-workspace-prewarm.js");
        signal.throwIfAborted();
        await prewarmLocalWorkspaceTemplates({ getConfig: params.getConfig, signal });
      },
      log: params.log,
      errorMessage: "post-ready sandbox dependency prewarm failed",
    }),
  ];
}
