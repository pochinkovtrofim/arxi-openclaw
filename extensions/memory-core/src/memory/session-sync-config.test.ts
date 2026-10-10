import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveSessionSyncDebounceMs } from "./session-sync-config.js";

function withDebounce(debounceMs: unknown): OpenClawConfig {
  return {
    plugins: { entries: { "memory-core": { config: { sessionSync: { debounceMs } } } } },
  } as OpenClawConfig;
}

describe("memory-core session index delay", () => {
  it("keeps the five-second default when unset", () => {
    expect(resolveSessionSyncDebounceMs({} as OpenClawConfig)).toBe(5_000);
    expect(
      resolveSessionSyncDebounceMs({
        plugins: { entries: { "memory-core": { enabled: true } } },
      } as OpenClawConfig),
    ).toBe(5_000);
  });

  it("uses a configured delay within the manifest bounds", () => {
    expect(resolveSessionSyncDebounceMs(withDebounce(60_000))).toBe(60_000);
    expect(resolveSessionSyncDebounceMs(withDebounce(1_000))).toBe(1_000);
    expect(resolveSessionSyncDebounceMs(withDebounce(3_600_000))).toBe(3_600_000);
  });

  it.each([0, 999, 3_600_001, 1_500.5, "60000", null])(
    "never arms a timer from the out-of-contract value %s",
    (value) => {
      expect(resolveSessionSyncDebounceMs(withDebounce(value))).toBe(5_000);
    },
  );
});
