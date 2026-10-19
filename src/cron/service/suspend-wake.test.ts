// A suspendWake "never" cadence stays on the in-process timer, leaves the host
// wake deadline, keeps due managed-Flow work as a wake, and catches up once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { upsertTaskFlowAutomationObligationInStateTransaction } from "../../tasks/task-flow-automation-obligation.store.sqlite.js";
import { createManagedTaskFlow } from "../../tasks/task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import { CronService } from "../service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { summarizeCronJobSchedule } from "./jobs-scheduling.js";
import { pauseScheduling, resumeScheduling, start, stop } from "./ops-lifecycle.js";
import { getSuspendWakeSnapshot } from "./ops-read.js";
import { createCronServiceState } from "./state.js";
import { MAX_CRON_TIMER_DELAY_MS, MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";
import { onTimer } from "./timer.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-suspend-wake" });
const EVERY_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

afterEach(async () => {
  resetTaskFlowRegistryForTests();
  // The cron receipt authority is an async state resource; a sync close leaves it stale.
  await closeStateDatabaseForTest();
});

function watchJob(params: {
  now: number;
  nextRunAtMs: number;
  id?: string;
  suspendWake?: CronJob["suspendWake"];
  pacing?: CronJob["pacing"];
}): CronJob {
  const createdAtMs = params.now - 24 * HOUR_MS;
  return {
    id: params.id ?? "watch",
    agentId: "main",
    name: params.id ?? "watch",
    enabled: true,
    createdAtMs,
    updatedAtMs: createdAtMs,
    schedule: { kind: "every", everyMs: EVERY_MS, anchorMs: createdAtMs },
    ...(params.pacing ? { pacing: params.pacing } : {}),
    sessionTarget: "isolated",
    wakeMode: "now",
    ...(params.suspendWake ? { suspendWake: params.suspendWake } : {}),
    payload: { kind: "agentTurn", message: "check the condition" },
    state: { nextRunAtMs: params.nextRunAtMs },
  };
}

function serviceDeps(storePath: string, clock: { now: number }) {
  const run = vi.fn(async () => ({ status: "ok" as const }));
  return {
    run,
    deps: {
      defaultAgentId: "main",
      cronEnabled: true,
      log: logger,
      scheduler: createTestGatewayScheduler(),
      storePath,
      nowMs: () => clock.now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: run,
    },
  };
}

// The suspend snapshot is a CronService read: the wrapper marks the scheduler
// started after lifecycle start, exactly as the gateway's suspension sees it.
async function startedService(storePath: string, clock: { now: number }) {
  const service = new CronService(serviceDeps(storePath, clock).deps);
  await service.start();
  service.pauseScheduling();
  return service;
}

async function startedState(storePath: string, clock: { now: number }) {
  const { deps, run } = serviceDeps(storePath, clock);
  const state = createCronServiceState(deps);
  await start(state);
  return { state, run };
}

describe("cron suspend wake policy", () => {
  it("keeps a never cadence on the timer and off the suspend snapshot", async () => {
    const { storePath } = await makeStorePath();
    const clock = { now: Date.parse("2026-03-23T02:00:00.000Z") };
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        watchJob({ now: clock.now, nextRunAtMs: clock.now + EVERY_MS, suspendWake: "never" }),
        watchJob({ now: clock.now, nextRunAtMs: clock.now + 6 * HOUR_MS, id: "reminder" }),
      ],
    });
    const service = await startedService(storePath, clock);
    try {
      expect(service.getSuspendWakeSnapshot()).toEqual({
        complete: true,
        nextWakeAtMs: clock.now + 6 * HOUR_MS,
      });
    } finally {
      service.stop();
    }
  });

  it("reports external-event-only sleep when every timed job defers the host wake", async () => {
    const { storePath } = await makeStorePath();
    const clock = { now: Date.parse("2026-03-23T02:00:00.000Z") };
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        watchJob({ now: clock.now, nextRunAtMs: clock.now + EVERY_MS, suspendWake: "never" }),
        watchJob({
          now: clock.now,
          nextRunAtMs: clock.now + 6 * HOUR_MS,
          id: "search",
          suspendWake: "never",
        }),
      ],
    });
    const service = await startedService(storePath, clock);
    try {
      expect(service.getSuspendWakeSnapshot()).toEqual({ complete: true, nextWakeAtMs: null });
    } finally {
      service.stop();
    }
  });

  it("keeps a due managed-Flow receipt as the host wake of a never job", async () => {
    const { storePath } = await makeStorePath();
    const clock = { now: Date.parse("2026-03-23T02:00:00.000Z") };
    const due = clock.now + 2 * HOUR_MS;
    const steward = watchJob({
      now: clock.now,
      nextRunAtMs: clock.now + EVERY_MS,
      id: "steward",
      suspendWake: "never",
      pacing: { min: "5m", max: "5m" },
    });
    await writeCronStoreSnapshot({ storePath, jobs: [steward] });
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/suspend-wake",
      goal: "exact reminder",
      status: "waiting",
    });
    const identity = tryCronScheduleIdentity(steward);
    if (!flow || !identity) {
      throw new Error("expected a managed Flow and a schedule identity");
    }
    runOpenClawStateWriteTransaction(({ db }) => {
      upsertTaskFlowAutomationObligationInStateTransaction(db, {
        flowId: flow.flowId,
        expectedFlowRevision: flow.revision,
        controllerId: "tests/suspend-wake",
        cronStoreKey: cronStoreKey(storePath),
        cronJobId: steward.id,
        cronScheduleIdentity: identity,
        sourceRunId: "paced-run",
        triggerAtMs: due,
        scheduledAtMs: due,
        triggerKind: "check",
        triggerDigest: "a".repeat(64),
      });
    });
    const service = await startedService(storePath, clock);
    try {
      // The 5-minute slot stays earlier than the receipt, so only the store knows the due time.
      expect(service.getSuspendWakeSnapshot()).toEqual({ complete: true, nextWakeAtMs: due });
      expect((await service.list({ includeDisabled: true }))[0]?.state.nextRunAtMs).toBe(
        clock.now + EVERY_MS,
      );
    } finally {
      service.stop();
    }
  });

  it("keeps the snapshot complete when a paced never job is added after startup", async () => {
    const { storePath } = await makeStorePath();
    const clock = { now: Date.parse("2026-03-23T02:00:00.000Z") };
    const due = clock.now + 2 * HOUR_MS;
    const steward = watchJob({
      now: clock.now,
      nextRunAtMs: clock.now + EVERY_MS,
      id: "steward",
      suspendWake: "never",
      pacing: { min: "5m", max: "5m" },
    });
    await writeCronStoreSnapshot({ storePath, jobs: [steward] });
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/suspend-wake",
      goal: "exact reminder",
      status: "waiting",
    });
    const identity = tryCronScheduleIdentity(steward);
    if (!flow || !identity) {
      throw new Error("expected a managed Flow and a schedule identity");
    }
    runOpenClawStateWriteTransaction(({ db }) => {
      upsertTaskFlowAutomationObligationInStateTransaction(db, {
        flowId: flow.flowId,
        expectedFlowRevision: flow.revision,
        controllerId: "tests/suspend-wake",
        cronStoreKey: cronStoreKey(storePath),
        cronJobId: steward.id,
        cronScheduleIdentity: identity,
        sourceRunId: "paced-run",
        triggerAtMs: due,
        scheduledAtMs: due,
        triggerKind: "check",
        triggerDigest: "a".repeat(64),
      });
    });
    const service = await startedService(storePath, clock);
    try {
      // A plugin reconciles its paced automation after cron start; the next
      // timer tick may be hours away, so the snapshot must not wait for it.
      await service.add({
        agentId: "main",
        name: "late paced automation",
        enabled: true,
        schedule: { kind: "every", everyMs: EVERY_MS, anchorMs: clock.now },
        pacing: { min: "10m", max: "10m" },
        suspendWake: "never",
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "check the condition" },
      });
      expect(service.getSuspendWakeSnapshot()).toEqual({ complete: true, nextWakeAtMs: due });
    } finally {
      service.stop();
    }
  });

  it("runs an overdue never job once at the first tick after resume", async () => {
    const { storePath } = await makeStorePath();
    const clock = { now: Date.parse("2026-03-23T02:00:00.000Z") };
    await writeCronStoreSnapshot({
      storePath,
      jobs: [watchJob({ now: clock.now, nextRunAtMs: clock.now + EVERY_MS, suspendWake: "never" })],
    });
    const { state, run } = await startedState(storePath, clock);
    try {
      pauseScheduling(state);
      expect(summarizeCronJobSchedule(state)).toMatchObject({
        nextWakeAtMs: clock.now + EVERY_MS,
        nextSuspendWakeAtMs: undefined,
      });
      // Eight hours asleep: dozens of missed five-minute ticks.
      clock.now += 8 * HOUR_MS;
      resumeScheduling(state);
      await onTimer(state);
      expect(run).toHaveBeenCalledTimes(1);
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.lastRunAtMs).toBe(clock.now);
      expect(persisted?.state.nextRunAtMs).toBe(clock.now + EVERY_MS);
      await onTimer(state);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      stop(state);
    }
  });

  it("completes the snapshot soon after a run even when suspension prepares keep re-arming", async () => {
    const { storePath } = await makeStorePath();
    const clock = { now: Date.parse("2026-03-23T02:00:00.000Z") };
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        watchJob({
          now: clock.now,
          nextRunAtMs: clock.now + EVERY_MS,
          id: "steward",
          suspendWake: "never",
          pacing: { min: "5m", max: "5m" },
        }),
      ],
    });
    const host = createGatewaySchedulerClock(clock.now);
    const { deps, run } = serviceDeps(storePath, clock);
    const state = createCronServiceState({
      ...deps,
      scheduler: createTestGatewayScheduler(host.clock),
    });
    await start(state);
    state.schedulerStarted = true;
    const lastDelay = () => host.wakes.findLast((wake) => !wake.cancelled)?.delayMs;
    try {
      expect(getSuspendWakeSnapshot(state)).toEqual({ complete: true, nextWakeAtMs: null });
      clock.now += EVERY_MS;
      await onTimer(state);
      expect(run).toHaveBeenCalledTimes(1);
      // The run consumed the receipts; the snapshot waits for a repair pass.
      expect(getSuspendWakeSnapshot(state)).toEqual({ complete: false });
      expect(lastDelay()).toBe(MIN_REFIRE_GAP_MS);
      // Each refused suspension prepare pauses and resumes scheduling.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        pauseScheduling(state);
        expect(getSuspendWakeSnapshot(state)).toEqual({ complete: false });
        resumeScheduling(state);
        expect(lastDelay()).toBe(MIN_REFIRE_GAP_MS);
      }
      clock.now += MIN_REFIRE_GAP_MS;
      await onTimer(state);
      expect(run).toHaveBeenCalledTimes(1);
      expect(getSuspendWakeSnapshot(state)).toEqual({ complete: true, nextWakeAtMs: null });
      expect(lastDelay()).toBe(MAX_CRON_TIMER_DELAY_MS);
    } finally {
      stop(state);
    }
  });
});
