import { getFileWatchCapacityCode } from "openclaw/plugin-sdk/file-access-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { MemoryFileWatcher, type MemoryWatchUnavailableReason } from "./file-watcher.js";
import { MemoryManagerSyncBase } from "./manager-sync-base.js";

const log = createSubsystemLogger("memory");

/** Content-free memory watcher state reported with a search: why it is down, or that it came back. */
export type MemoryWatchDiagnosticState = MemoryWatchUnavailableReason | "recovered";

// A watcher that failed (watch capacity, reconciliation, start) is rebuilt with
// bounded backoff instead of staying down for the life of the manager.
const WATCH_RECOVERY_INITIAL_DELAY_MS = 30_000;
const WATCH_RECOVERY_MAX_DELAY_MS = 10 * 60_000;
// Without a watcher, edits are picked up by a maintenance sync that a search may
// request at most once per minute, plus a periodic sync between searches. A search
// never starts one per call: each sync re-inspects every memory file.
const DEGRADED_WATCH_SEARCH_SYNC_MIN_INTERVAL_MS = 60_000;
const DEGRADED_WATCH_PERIODIC_SYNC_MS = 5 * 60_000;

function classifyWatchStartFailure(error: unknown): MemoryWatchUnavailableReason {
  const code = getFileWatchCapacityCode(error);
  if (code === "ENOSPC") {
    return "enospc";
  }
  return code ? "emfile" : "start_failed";
}

export abstract class MemoryManagerWatchOps extends MemoryManagerSyncBase {
  private fileWatcher: MemoryFileWatcher | undefined;
  protected memoryWatcherReady: Promise<void> = Promise.resolve();
  private memoryWatchUnavailableReason: MemoryWatchUnavailableReason | undefined;
  private memoryWatchUnavailableEpoch = 0;
  private memoryWatchRecoveredPending = false;
  private memoryWatchRecoveryTimer: NodeJS.Timeout | null = null;
  private memoryWatchRecoveryDelayMs = WATCH_RECOVERY_INITIAL_DELAY_MS;
  private memoryWatchRebuilding = false;
  private degradedWatchSyncTimer: NodeJS.Timeout | null = null;
  private lastDegradedWatchSyncAt = Number.NEGATIVE_INFINITY;
  private remoteWatchRetirement: Promise<void> | undefined;
  private remoteWatchCloseFailure: { error: unknown } | undefined;
  protected get memoryWatchCapacityDegraded(): boolean {
    return this.fileWatcher?.capacityDegraded ?? false;
  }

  protected get memoryWatcherHealth() {
    return this.fileWatcher?.health();
  }

  /** True while no watcher observes memory edits. */
  protected get memoryWatchDegraded(): boolean {
    return this.memoryWatchCapacityDegraded || this.memoryWatchUnavailable;
  }

  /**
   * Whether this search may request a maintenance sync for a degraded watcher:
   * at most once per interval, so searches never each start a full re-inspection.
   */
  protected claimDegradedWatchSearchSync(now = Date.now()): boolean {
    if (!this.memoryWatchDegraded) {
      return false;
    }
    if (now - this.lastDegradedWatchSyncAt < DEGRADED_WATCH_SEARCH_SYNC_MIN_INTERVAL_MS) {
      return false;
    }
    this.lastDegradedWatchSyncAt = now;
    return true;
  }

  /** The watcher state a search reports; "recovered" is reported once after a rebuild. */
  protected readMemoryWatchDiagnostic(): MemoryWatchDiagnosticState | undefined {
    if (this.memoryWatchDegraded) {
      return this.memoryWatchUnavailableReason ?? "start_failed";
    }
    if (this.memoryWatchRecoveredPending) {
      this.memoryWatchRecoveredPending = false;
      return "recovered";
    }
    return undefined;
  }

  private markMemoryWatchUnavailable(reason: MemoryWatchUnavailableReason): void {
    if (this.closed) {
      return;
    }
    this.memoryWatchUnavailable = true;
    this.memoryWatchUnavailableReason = reason;
    this.memoryWatchUnavailableEpoch += 1;
    this.memoryWatchRecoveredPending = false;
    this.dirty = true;
    this.ensureDegradedWatchSync();
  }

  private ensureDegradedWatchSync(): void {
    if (this.degradedWatchSyncTimer || this.closed) {
      return;
    }
    this.degradedWatchSyncTimer = setInterval(() => {
      if (!this.memoryWatchDegraded || this.closed) {
        this.stopDegradedWatchSync();
        return;
      }
      this.lastDegradedWatchSyncAt = Date.now();
      this.dirty = true;
      this.syncInBackground({ reason: "watch" });
    }, DEGRADED_WATCH_PERIODIC_SYNC_MS);
    this.degradedWatchSyncTimer.unref?.();
  }

  private stopDegradedWatchSync(): void {
    if (this.degradedWatchSyncTimer) {
      clearInterval(this.degradedWatchSyncTimer);
      this.degradedWatchSyncTimer = null;
    }
  }

  private scheduleMemoryWatchRecovery(): void {
    if (this.memoryWatchRecoveryTimer || this.closed || this.memoryFiles) {
      return;
    }
    const delayMs = this.memoryWatchRecoveryDelayMs;
    this.memoryWatchRecoveryDelayMs = Math.min(delayMs * 2, WATCH_RECOVERY_MAX_DELAY_MS);
    this.memoryWatchRecoveryTimer = setTimeout(() => {
      this.memoryWatchRecoveryTimer = null;
      void this.rebuildMemoryWatcher().catch((error: unknown) => {
        log.warn(`memory workspace watcher rebuild failed: ${String(error)}`);
      });
    }, delayMs);
    this.memoryWatchRecoveryTimer.unref?.();
  }

  private async rebuildMemoryWatcher(): Promise<void> {
    if (this.closed || !this.memoryWatchDegraded || this.memoryWatchRebuilding) {
      return;
    }
    const watcher = await this.replaceMemoryFileWatcher();
    if (!watcher) {
      return;
    }
    const epoch = this.memoryWatchUnavailableEpoch;
    try {
      await watcher.start();
    } catch (error: unknown) {
      if (this.fileWatcher === watcher) {
        this.markMemoryWatchUnavailable(classifyWatchStartFailure(error));
        this.scheduleMemoryWatchRecovery();
      }
      return;
    }
    if (
      this.closed ||
      this.fileWatcher !== watcher ||
      watcher.capacityDegraded ||
      this.memoryWatchUnavailableEpoch !== epoch
    ) {
      // The rebuilt watcher reported its own failure, which scheduled the next attempt.
      return;
    }
    this.memoryWatchUnavailable = false;
    this.memoryWatchUnavailableReason = undefined;
    this.memoryWatchRecoveredPending = true;
    this.memoryWatchRecoveryDelayMs = WATCH_RECOVERY_INITIAL_DELAY_MS;
    this.stopDegradedWatchSync();
    log.info("memory workspace watcher recovered");
    // Edits made while no watcher ran are picked up once, now.
    this.dirty = true;
    this.syncInBackground({ reason: "watch" });
  }

  /** Closes the failed watcher and creates its replacement; ensureWatcher waits meanwhile. */
  private async replaceMemoryFileWatcher(): Promise<MemoryFileWatcher | undefined> {
    this.memoryWatchRebuilding = true;
    try {
      const previous = this.fileWatcher;
      this.fileWatcher = undefined;
      await previous?.close().catch((error: unknown) => {
        log.warn(`memory watcher close failed: ${String(error)}`);
      });
      return this.closed ? undefined : this.createMemoryFileWatcher();
    } finally {
      this.memoryWatchRebuilding = false;
    }
  }

  private createMemoryFileWatcher(): MemoryFileWatcher {
    const watcher: MemoryFileWatcher = new MemoryFileWatcher({
      runInBackgroundContext: this.runInBackgroundContext,
      workspaceDir: this.workspaceDir,
      agentId: this.agentId,
      settings: this.settings,
      onDirty: () => this.markMemoryWatchDirty(),
      onChange: () => {
        this.markMemoryWatchDirty();
        return this.sync({ reason: "watch" });
      },
      onUnavailable: (reason) => {
        if (this.fileWatcher !== watcher) {
          return;
        }
        this.markMemoryWatchUnavailable(reason);
        this.scheduleMemoryWatchRecovery();
      },
    });
    this.fileWatcher = watcher;
    return watcher;
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.closed) {
      return;
    }
    if (this.memoryFiles) {
      if (this.memoryWatchSubscription || this.memoryWatchUnavailable) {
        return;
      }
      const subscription = new AbortController();
      this.memoryWatchSubscription = subscription;
      const markDirty = (event: "change" | "unavailable") => {
        if (subscription.signal.aborted || this.closed) {
          return;
        }
        this.markMemoryWatchDirty();
        if (event === "unavailable") {
          this.markMemoryWatchUnavailable("start_failed");
        }
        // Remote notifications have already passed native file settling on the host.
        this.syncInBackground({ reason: "watch" });
      };
      this.remoteWatchRetirement = this.memoryFiles
        .watch(
          {
            agentId: this.agentId,
            settings: {
              extraPaths: this.settings.extraPaths,
              multimodal: this.settings.multimodal,
              sync: { watchDebounceMs: this.settings.sync.watchDebounceMs },
            },
          },
          markDirty,
          subscription.signal,
        )
        .then(
          () => markDirty("unavailable"),
          (error: unknown) => {
            markDirty("unavailable");
            if (!subscription.signal.aborted) {
              log.warn(`memory workspace watcher unavailable: ${String(error)}`);
            } else if (error !== subscription.signal.reason) {
              // Cancellation is expected; a distinct transport retirement failure
              // must survive shutdown instead of being mistaken for a joined worker.
              this.remoteWatchCloseFailure = { error };
            }
          },
        );
      return;
    }
    if (this.fileWatcher || this.memoryWatchRebuilding) {
      return;
    }
    const watcher = this.createMemoryFileWatcher();
    this.memoryWatcherReady = watcher.start().catch((error: unknown) => {
      if (!this.closed && this.fileWatcher === watcher) {
        this.markMemoryWatchUnavailable(classifyWatchStartFailure(error));
        this.scheduleMemoryWatchRecovery();
        log.warn(`memory workspace watcher unavailable: ${String(error)}`);
      }
    });
  }

  protected async closeWatchResources(): Promise<void> {
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.memoryWatchRecoveryTimer) {
      clearTimeout(this.memoryWatchRecoveryTimer);
      this.memoryWatchRecoveryTimer = null;
    }
    this.stopDegradedWatchSync();
    this.memoryWatchSubscription?.abort();
    this.memoryWatchSubscription = undefined;
    const results = await Promise.allSettled([
      (async () => {
        // Abort only requests remote cancellation. Its transport owns and joins
        // the worker; retain the subscription until that physical join settles.
        await this.remoteWatchRetirement;
        if (this.remoteWatchCloseFailure) {
          throw this.remoteWatchCloseFailure.error;
        }
        this.remoteWatchRetirement = undefined;
      })(),
      (async () => {
        await this.fileWatcher?.close();
        // A failed observer retains its rejected retirement join.
        this.fileWatcher = undefined;
      })(),
      (async () => {
        this.sessionUnsubscribe?.();
        this.sessionUnsubscribe = null;
      })(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Memory watch resources cleanup failed");
    }
  }

  protected syncInBackground(params: MemorySyncParams, failureReason = params.reason): void {
    const failed = (err: unknown) => {
      log.warn(`memory sync failed (${failureReason}): ${String(err)}`);
    };
    try {
      this.runInBackgroundContext(() => {
        void this.runInBackgroundContext(() => this.sync(params)).catch(failed);
      });
    } catch (err) {
      failed(err);
    }
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = resolveTimerTimeoutMs(minutes * 60 * 1000, 0, 0);
    if (ms <= 0) {
      return;
    }
    this.intervalTimer = setInterval(() => {
      this.syncInBackground({ reason: "interval" });
    }, ms);
  }
}
