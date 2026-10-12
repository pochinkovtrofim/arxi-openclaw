import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../cron/service.test-harness.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { loadCronStore } from "../cron/store.js";
import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import {
  createRegistry,
  startPluginServices,
  type PluginServicesHandle,
} from "./services.test-support.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "plugin-service-cron-" });
const handles = new Set<PluginServicesHandle>();
const schedulers = new Set<CronService>();
const family = {
  declarationKey: "test-plugin:maintenance",
  name: "Plugin maintenance",
  ownerPluginTag: "[managed-by=test-plugin]",
};

afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.stop()));
  handles.clear();
  for (const cron of schedulers) {
    cron.stop();
  }
  schedulers.clear();
});

async function createScheduler(overrides: Partial<CronServiceDeps> = {}) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: false,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
  schedulers.add(cron);
  return { cron, storePath };
}

async function startService(getCronService?: () => CronService, pluginId = "test-plugin") {
  let context: OpenClawPluginServiceContext | undefined;
  const registry = createRegistry(
    [
      {
        id: "maintenance",
        start: (ctx) => {
          context = ctx;
        },
      },
    ],
    pluginId,
  );
  const handle = await startPluginServices({ registry, config: {}, getCronService });
  handles.add(handle);
  return { context: expectDefined(context, "started service context"), handle };
}

function createJob(name = family.name) {
  return {
    declarationKey: family.declarationKey,
    name,
    description: family.ownerPluginTag,
    enabled: false,
    schedule: { kind: "cron" as const, expr: "0 2 * * *" },
    sessionTarget: "main" as const,
    wakeMode: "now" as const,
    payload: { kind: "systemEvent" as const, text: "maintenance" },
  };
}

describe("plugin service scheduler ownership", () => {
  it("runs only the owning plugin's current job through the native trigger", async () => {
    const { cron } = await createScheduler();
    const owned = await cron.add({ ...createJob(), enabled: true });
    const foreign = await cron.add({
      ...createJob("Other plugin"),
      declarationKey: "other-plugin:maintenance",
      enabled: true,
    });
    const { context } = await startService(() => cron);
    const service = expectDefined(context.getCron?.(), "plugin cron service");

    expect(service.getJob(owned.id)?.id).toBe(owned.id);
    expect(service.getJob(foreign.id)).toBeUndefined();
    await expect(service.run(foreign.id, "force", { evaluateTrigger: true })).rejects.toThrow(
      "not owned by this plugin",
    );
    await expect(service.run(owned.id, "force", { evaluateTrigger: true })).resolves.toMatchObject({
      ok: true,
      ran: true,
    });
  });

  it("atomically merges one trigger-state namespace and rejects stale revisions", async () => {
    const { cron } = await createScheduler();
    const job = await cron.add({
      ...createJob(),
      state: {
        triggerState: {
          arxiOwnerBackgroundPolicy: { revision: 1, pending: ["first"] },
          nativeTrigger: { cursor: "keep" },
        },
      },
    });
    const { context } = await startService(() => cron);
    const service = expectDefined(context.getCron?.(), "plugin cron service");

    const first = await service.mutateTriggerState(job.id, {
      key: "arxiOwnerBackgroundPolicy",
      expectedRevision: 1,
      value: { revision: 2, pending: ["first", "second"] },
    });
    expect(first.state?.triggerState).toEqual({
      arxiOwnerBackgroundPolicy: { revision: 2, pending: ["first", "second"] },
      nativeTrigger: { cursor: "keep" },
    });
    await expect(
      service.mutateTriggerState(job.id, {
        key: "arxiOwnerBackgroundPolicy",
        expectedRevision: Number.MAX_SAFE_INTEGER,
        value: { revision: Number.MAX_SAFE_INTEGER },
      }),
    ).rejects.toThrow("trigger state mutation is invalid");

    const writers = await Promise.allSettled([
      service.mutateTriggerState(job.id, {
        key: "arxiOwnerBackgroundPolicy",
        expectedRevision: 2,
        value: { revision: 3, writer: "a" },
      }),
      service.mutateTriggerState(job.id, {
        key: "arxiOwnerBackgroundPolicy",
        expectedRevision: 2,
        value: { revision: 3, writer: "b" },
      }),
    ]);
    expect(writers.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const stored = cron.getJob(job.id);
    expect(stored?.state.triggerState).toMatchObject({
      arxiOwnerBackgroundPolicy: { revision: 3 },
      nativeTrigger: { cursor: "keep" },
    });
  });

  it("snapshots a mutation before waiting for the cron store lock", async () => {
    const { cron } = await createScheduler();
    const job = await cron.add(createJob());
    const { context } = await startService(() => cron);
    const service = expectDefined(context.getCron?.(), "plugin cron service");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const blocker = cron.updateWithPrecondition(job.id, {}, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const value = { revision: 1, marker: "captured" };
    const mutation = { key: "capturedState", expectedRevision: 0, value };
    const queued = service.mutateTriggerState(job.id, mutation);
    mutation.key = "changedState";
    mutation.expectedRevision = 99;
    value.revision = 100;
    value.marker = "changed";

    try {
      release.resolve();
      await blocker;
      await expect(queued).resolves.toMatchObject({
        state: { triggerState: { capturedState: { revision: 1, marker: "captured" } } },
      });
      expect(cron.getJob(job.id)?.state.triggerState).toEqual({
        capturedState: { revision: 1, marker: "captured" },
      });
    } finally {
      release.resolve();
      await blocker.catch(() => undefined);
      await queued.catch(() => undefined);
    }
  });

  it("preserves native trigger and scheduler state across an in-flight evaluation", async () => {
    const evaluationEntered = createDeferredCore<unknown>();
    const releaseEvaluation = createDeferredCore();
    const { cron } = await createScheduler({
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      evaluateCronTrigger: vi.fn(async ({ state }) => {
        evaluationEntered.resolve(state);
        await releaseEvaluation.promise;
        return {
          kind: "evaluated" as const,
          fire: false,
          state: {
            ...(state as Record<string, unknown>),
            nativeTrigger: { revision: 2, cursor: "stale-completion" },
          },
        };
      }),
    });
    await cron.start();
    const job = await cron.add({
      ...createJob(),
      enabled: true,
      trigger: { script: "json({ fire: false })" },
      state: {
        triggerState: {
          nativeTrigger: { revision: 1, cursor: "original" },
          unrelated: { retained: true },
        },
      },
    });
    const { context } = await startService(() => cron);
    const service = expectDefined(context.getCron?.(), "plugin cron service");

    const run = cron.run(job.id, "force", { evaluateTrigger: true });
    try {
      await evaluationEntered.promise;
      const beforeMutation = structuredClone(
        expectDefined(cron.getJob(job.id), "running job").state,
      );
      const updated = await service.mutateTriggerState(job.id, {
        key: "arxiInterestPolicies",
        expectedRevision: 0,
        value: { revision: 1, policies: { first: { status: "reserved" } } },
      });
      expect(updated.state).toEqual({
        ...beforeMutation,
        triggerState: {
          nativeTrigger: { revision: 1, cursor: "original" },
          unrelated: { retained: true },
          arxiInterestPolicies: { revision: 1, policies: { first: { status: "reserved" } } },
        },
      });

      releaseEvaluation.resolve();
      await expect(run).resolves.toMatchObject({ ok: true, ran: true });
      expect(cron.getJob(job.id)?.state.triggerState).toEqual({
        nativeTrigger: { revision: 1, cursor: "original" },
        unrelated: { retained: true },
        arxiInterestPolicies: { revision: 1, policies: { first: { status: "reserved" } } },
      });
    } finally {
      releaseEvaluation.resolve();
      await run.catch(() => undefined);
    }
  });

  it("retains core validation for system-owned cron jobs", async () => {
    const { cron } = await createScheduler();
    const job = await cron.add(
      { ...createJob(), declarationKey: "heartbeat:protected" },
      { systemOwned: true },
    );
    const { context } = await startService(() => cron);
    const service = expectDefined(context.getCron?.(), "plugin cron service");

    await expect(
      service.mutateTriggerState(job.id, {
        key: "pluginState",
        expectedRevision: 0,
        value: { revision: 1 },
      }),
    ).rejects.toThrow("system-owned monitor jobs cannot be edited by cron clients");
    expect(cron.getJob(job.id)?.state.triggerState).toBeUndefined();
  });

  it("binds protected trigger-state mutation to the owning plugin registration", async () => {
    const { cron } = await createScheduler();
    const steward = await cron.add({
      ...createJob(),
      declarationKey: "arxi:proactive-steward:main",
    });
    const owner = await startService(() => cron, "arxi");
    const unrelated = await startService(() => cron, "unrelated");
    const ownerCron = expectDefined(owner.context.getCron?.(), "owning plugin cron service");
    const unrelatedCron = expectDefined(
      unrelated.context.getCron?.(),
      "unrelated plugin cron service",
    );

    await expect(
      unrelatedCron.mutateTriggerState(steward.id, {
        key: "arxiOwnerBackgroundPolicy",
        expectedRevision: 0,
        value: { revision: 1 },
      }),
    ).rejects.toThrow("not owned by this plugin");
    const updated = await ownerCron.mutateTriggerState(steward.id, {
      key: "arxiOwnerBackgroundPolicy",
      expectedRevision: 0,
      value: { revision: 1 },
    });
    expect(updated.state?.triggerState).toEqual({
      arxiOwnerBackgroundPolicy: { revision: 1 },
    });
  });
  it("keeps one handle per scheduler and reconciles through a successor service", async () => {
    const { cron } = await createScheduler();
    const first = await startService(() => cron);
    const service = expectDefined(first.context.getCron?.(), "Gateway scheduler");
    expect(first.context.getCron?.()).toBe(service);
    const isEnabled = expectDefined(service.isEnabled, "scheduler enabled observation");
    expect(await isEnabled()).toBe(false);
    await service.add(createJob());
    await first.handle.stop();
    expect(() => first.context.getCron?.()).toThrow("no longer active");
    await expect(service.list()).rejects.toThrow("no longer active");
    await expect(isEnabled()).rejects.toThrow("no longer active");
    await expect(
      expectDefined(service.enqueueRun, "service run admission")("retained", "if-enabled"),
    ).rejects.toThrow("no longer active");

    const next = await startService(() => cron);
    const successor = expectDefined(next.context.getCron?.(), "replacement scheduler");
    const job = expectDefined(
      (await successor.list({ includeDisabled: true }))[0],
      "managed plugin job",
    );
    expect(job).toMatchObject({ declarationKey: family.declarationKey });
    await successor.update(job.id, { schedule: { kind: "cron", expr: "0 3 * * *" } });
    expect(await successor.list({ includeDisabled: true })).toMatchObject([
      { id: job.id, schedule: { expr: "0 3 * * *" } },
    ]);
  });

  it.each(["service stop", "scheduler replacement"] as const)(
    "rejects reads and writes queued before %s without changing stored rows",
    async (retirement) => {
      const original = await createScheduler();
      const replacement = await createScheduler();
      const job = await original.cron.add({ ...createJob(), enabled: true });
      let current = original.cron;
      const { context, handle } = await startService(() => current);
      const service = expectDefined(context.getCron?.(), "Gateway scheduler");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const blocker = original.cron.updateWithPrecondition(job.id, {}, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = [
        expectDefined(service.isEnabled, "scheduler enabled observation")(),
        service.list({ includeDisabled: true }),
        service.add({ ...createJob("late addition"), declarationKey: "test-plugin:late" }),
        service.update(job.id, { name: "late update" }),
        service.mutateTriggerState(job.id, {
          key: "lateState",
          expectedRevision: 0,
          value: { revision: 1 },
        }),
        service.remove(job.id),
        service.removeStaleJobFamily(family),
        expectDefined(service.enqueueRun, "service run admission")(job.id, "if-enabled"),
      ];
      const results = Promise.allSettled(queued);
      let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;
      try {
        if (retirement === "scheduler replacement") {
          current = replacement.cron;
          expect(context.getCron?.()).not.toBe(service);
        } else {
          stopping = handle.stop();
          expect(() => context.getCron?.()).toThrow("stopping");
        }
      } finally {
        release.resolve();
        await stopping;
        await blocker;
        await results;
      }
      expect((await results).map((result) => result.status)).toEqual(Array(8).fill("rejected"));
      expect((await loadCronStore(original.storePath)).jobs).toMatchObject([
        { id: job.id, name: family.name },
      ]);
      expect((await loadCronStore(replacement.storePath)).jobs).toHaveLength(0);
    },
  );
});

it("shares the canonical runtime identity only while the exporter lease is active", async () => {
  let readIdentity: NonNullable<
    OpenClawPluginServiceContext["internalDiagnostics"]
  >["getRuntimeIdentity"];
  const registry = createRegistry(
    [
      {
        id: "diagnostics-prometheus",
        start: (ctx) => {
          readIdentity = ctx.internalDiagnostics?.getRuntimeIdentity;
        },
      },
    ],
    "diagnostics-prometheus",
    "bundled",
  );
  const handle = await startPluginServices({
    registry,
    config: {},
    onHandle: (issued) => handles.add(issued),
  });
  const buildId = resolveRuntimeServiceBuildId();
  expect(readIdentity?.()).toEqual({
    processInstanceId: getGatewayProcessInstanceId(),
    ...(buildId ? { buildId } : {}),
  });
  await handle.stop();
  expect(() => readIdentity?.()).toThrow("no longer active");
});
