import { describe, expect, it, vi } from "vitest";
import {
  MemoryFileWatchResources,
  type MemoryFileWatchCallbacks,
} from "./manager-watch-resources.js";

class ReconcilingWatchResources extends MemoryFileWatchResources {
  constructor(callbacks: MemoryFileWatchCallbacks) {
    super(
      "main",
      {
        extraPaths: [],
        multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
        sync: { watchDebounceMs: 0 },
      },
      callbacks,
    );
  }

  protected async startWatching(): Promise<void> {}

  reconcile(run: () => Promise<void>): Promise<void> {
    return this.enqueueReconciliation("root", run);
  }
}

describe("memory watch resources", () => {
  it("reports a failed reconciliation as the closed reason reconcile_failed", async () => {
    const onUnavailable = vi.fn();
    const onDirty = vi.fn();
    const resources = new ReconcilingWatchResources({
      onChange: vi.fn(),
      onDirty,
      onUnavailable,
    });
    try {
      await resources.start();
      await resources.reconcile(async () => {
        throw new Error("probe failed");
      });
      await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledWith("reconcile_failed"));
      expect(onDirty).toHaveBeenCalled();
    } finally {
      await resources.close();
    }
  });
});
