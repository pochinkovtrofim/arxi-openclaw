import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { upsertTaskFlowAutomationObligationInStateTransaction } from "../../tasks/task-flow-automation-obligation.store.sqlite.js";
import { createManagedTaskFlow } from "../../tasks/task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import { CronService } from "../service.js";
import { loadCronJobsStoreSync, saveCronJobsStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { repairManagedFlowAutomationObligations } from "./managed-flow-obligation-repair.js";
import { createCronServiceState } from "./state.js";

let storePath: string;
let job: CronJob;
let due: number;
const services: CronService[] = [];
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const run = vi.fn(async () => ({ status: "ok" as const }));
function deps(cronEnabled = true) {
  return {
    storePath,
    cronEnabled,
    log,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: run,
  };
}
function stored() {
  return loadCronJobsStoreSync(storePath).jobs[0];
}

beforeEach(async () => {
  due = Date.now() + 7_200_000;
  storePath = path.join(os.tmpdir(), `obligation-startup-${randomUUID()}`, "jobs.json");
  job = {
    id: randomUUID(),
    name: "retained",
    agentId: "main",
    sessionKey: "agent:main:main",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 86_400_000, anchorMs: Date.now() },
    pacing: { min: "15m", max: "24h" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Inspect current work" },
    state: {},
  };
  await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
  const flow = createManagedTaskFlow({
    ownerKey: "agent:main:main",
    controllerId: "tests/startup",
    goal: "retained work",
    status: "waiting",
  });
  if (!flow) throw new Error("expected Flow");
  const identity = tryCronScheduleIdentity(job);
  if (!identity) throw new Error("expected schedule identity");
  runOpenClawStateWriteTransaction(({ db }) => {
    upsertTaskFlowAutomationObligationInStateTransaction(db, {
      flowId: flow.flowId,
      expectedFlowRevision: flow.revision,
      controllerId: "tests/startup",
      cronStoreKey: cronStoreKey(storePath),
      cronJobId: job.id,
      cronScheduleIdentity: identity,
      sourceRunId: randomUUID(),
      triggerAtMs: due,
      scheduledAtMs: due,
      triggerKind: "check",
      triggerDigest: "a".repeat(64),
    });
  });
});
afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  resetTaskFlowRegistryForTests();
  await saveCronJobsStore(storePath, { version: 1, jobs: [] });
  vi.clearAllMocks();
});

describe("durable Automation obligation scheduler startup", () => {
  it("restores the exact receipt through real CronService start and a second fresh service", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await saveCronJobsStore(storePath, { version: 1, jobs: [{ ...stored(), state: {} }] });
      const service = new CronService(deps());
      services.push(service);
      await service.start();
      expect(stored().state.nextRunAtMs).toBe(due);
      expect(stored().state.pacedNextRunAtMs).toBe(due);
      expect(run).not.toHaveBeenCalled();
      service.stop();
    }
  });

  it("preserves an earlier valid timer and does not change paused or disabled scheduling", async () => {
    const earlier = due - 60_000;
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [{ ...job, state: { nextRunAtMs: earlier } }],
    });
    const state = createCronServiceState(deps());
    state.store = loadCronJobsStoreSync(storePath);
    expect(repairManagedFlowAutomationObligations(state)).toBe(false);
    expect(stored().state.nextRunAtMs).toBe(earlier);
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    state.store = loadCronJobsStoreSync(storePath);
    state.schedulingPaused = true;
    expect(repairManagedFlowAutomationObligations(state)).toBe(false);
    expect(stored().state.nextRunAtMs).toBeUndefined();
    state.schedulingPaused = false;
    await saveCronJobsStore(storePath, { version: 1, jobs: [{ ...job, enabled: false }] });
    state.store = loadCronJobsStoreSync(storePath);
    expect(repairManagedFlowAutomationObligations(state)).toBe(false);
    expect(stored().enabled).toBe(false);
    expect(stored().state.nextRunAtMs).toBeUndefined();
  });
});
