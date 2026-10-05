import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { inspectPendingDeliveryQueueDeferrals } from "./delivery-queue-sqlite.js";
import { upsertDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite.kernel.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("delivery queue deferral inventory", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-health-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns only content-free pending and future-deferral facts", async () => {
    const now = 10_000;
    for (const entry of [
      { id: "ordinary", enqueuedAt: 1, retryCount: 0 },
      { id: "expired", enqueuedAt: 2, retryCount: 0, deferredUntilMs: now },
      { id: "later", enqueuedAt: 3, retryCount: 0, deferredUntilMs: now + 2_000 },
      { id: "earlier", enqueuedAt: 4, retryCount: 0, deferredUntilMs: now + 1_000 },
    ]) {
      upsertDeliveryQueueEntryInDatabase(
        { queueName: "outbound", entry },
        openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }),
      );
    }
    upsertDeliveryQueueEntryInDatabase(
      {
        queueName: "other-q",
        entry: { id: "other", enqueuedAt: 5, retryCount: 0, deferredUntilMs: now + 500 },
      },
      openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }),
    );

    await expect(inspectPendingDeliveryQueueDeferrals("outbound", now, stateDir)).resolves.toEqual({
      pendingCount: 4,
      futureDeferredCount: 2,
      earliestDeferredUntilMs: now + 1_000,
    });
  });
});
