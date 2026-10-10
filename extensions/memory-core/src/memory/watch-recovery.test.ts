import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryIndexManager } from "./manager.js";

type WatchInternals = {
  memoryWatchUnavailable: boolean;
  readMemoryWatchDiagnostic: () => string | undefined;
  syncPublishedIndexInBackground: (...args: unknown[]) => Promise<void>;
  sync: (params?: { reason?: string }) => Promise<void>;
};

describe.skipIf(process.platform !== "linux")("memory watcher recovery", () => {
  it("syncs a degraded watcher periodically, never per search, and rebuilds it with backoff", async () => {
    const state = await createOpenClawTestState({ label: "memory-watch-recovery" });
    const memoryDir = path.join(state.workspaceDir, "memory");
    const originalWatch = nativeFs.watch;
    let exhausted = true;
    const nativeWatch = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
      if (exhausted && String(args[0]) === memoryDir) {
        throw Object.assign(new Error("ENOSPC: native watch capacity exhausted"), {
          code: "ENOSPC",
          syscall: "watch",
          path: memoryDir,
        });
      }
      return originalWatch(...args);
    });
    syncBuiltinESMExports();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      shouldAdvanceTime: true,
    });
    let manager: MemoryIndexManager | null = null;
    try {
      await configureMemoryCoreDreamingStateForTests(state.env);
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(path.join(memoryDir, "baseline.md"), "Amber lantern baseline.");
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
        memory: {
          search: {
            provider: "none",
            sources: ["memory"],
            store: { vector: { enabled: false } },
            query: { minScore: 0 },
          },
        },
      };
      manager = await MemoryIndexManager.get({ cfg, agentId: "main" });
      if (!manager) {
        throw new Error("memory manager unavailable");
      }
      const activeManager = manager;
      const internals = activeManager as unknown as WatchInternals;
      await activeManager.sync({ reason: "test-initial-index" });
      await expect.poll(() => internals.memoryWatchUnavailable).toBe(true);
      expect(internals.readMemoryWatchDiagnostic()).toBe("enospc");

      // Searches never each start a maintenance sync while the watcher is down.
      const backgroundSync = vi.spyOn(internals, "syncPublishedIndexInBackground");
      for (let i = 0; i < 5; i++) {
        await activeManager.search("Amber lantern");
      }
      expect(backgroundSync.mock.calls.length).toBeLessThanOrEqual(1);

      // A periodic maintenance sync still picks up edits between searches.
      const sync = vi.spyOn(internals, "sync");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sync.mock.calls.some(([params]) => params?.reason === "watch")).toBe(true);
      expect(internals.memoryWatchUnavailable).toBe(true);

      // Once capacity returns, a rebuild (bounded backoff, at most 10 minutes) restores
      // watching, clears the flag and reports "recovered" exactly once.
      exhausted = false;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect.poll(() => internals.memoryWatchUnavailable).toBe(false);
      expect(internals.readMemoryWatchDiagnostic()).toBe("recovered");
      expect(internals.readMemoryWatchDiagnostic()).toBeUndefined();

      // The rebuilt watcher observes edits again.
      await fs.writeFile(path.join(memoryDir, "fresh.md"), "Cobalt heron discovered.");
      await expect
        .poll(
          async () =>
            (await activeManager.search("Cobalt heron")).map((result) => result.snippet),
          { timeout: 10_000 },
        )
        .toContain("Cobalt heron discovered.");
    } finally {
      await manager?.close();
      vi.useRealTimers();
      nativeWatch.mockRestore();
      syncBuiltinESMExports();
      resetMemoryCoreDreamingStateForTests();
      await state.cleanup();
    }
  }, 60_000);
});
