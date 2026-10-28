import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { MemoryIndexManager } from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory manager startup session scan delay", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const withStartupCatchupDelay = (startupCatchupDelayMs: number): OpenClawConfig => {
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["sessions"],
      sessionMemory: true,
    });
    return {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        entries: {
          ...cfg.plugins?.entries,
          "memory-core": { config: { sessionSync: { startupCatchupDelayMs } } },
        },
      },
    };
  };

  const spyOnCatchup = () =>
    vi.spyOn(
      MemoryIndexManager.prototype as unknown as {
        ensureSessionStartupCatchup: () => Promise<void>;
      },
      "ensureSessionStartupCatchup",
    );

  it("scans once the delay has passed, not when the index opens", async () => {
    const catchup = spyOnCatchup();
    await fixture.getFreshManager(withStartupCatchupDelay(200));
    expect(catchup).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(catchup).toHaveBeenCalledTimes(1));
  });

  it("drops the pending scan when the index closes first", async () => {
    const catchup = spyOnCatchup();
    const manager = await fixture.getFreshManager(withStartupCatchupDelay(60_000));
    await manager.close();
    expect(Reflect.get(manager, "sessionStartupCatchupTimer")).toBeNull();
    expect(catchup).not.toHaveBeenCalled();
  });
});
