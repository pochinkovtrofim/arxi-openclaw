import { describe, expect, it, vi } from "vitest";
import { combineGatewaySuspendWakeSnapshot } from "./suspend.js";

describe("gateway suspend wake snapshot", () => {
  it("uses the earlier durable outbound deferral", () => {
    const inspect = vi.fn(() => 1_700_000_000_000);
    expect(
      combineGatewaySuspendWakeSnapshot(
        { complete: true, nextWakeAtMs: 1_800_000_000_000 },
        inspect,
      ),
    ).toEqual({ complete: true, nextWakeAtMs: 1_700_000_000_000 });
  });

  it("preserves an earlier cron wake and external-event-only when no delivery is deferred", () => {
    expect(
      combineGatewaySuspendWakeSnapshot(
        { complete: true, nextWakeAtMs: 1_700_000_000_000 },
        () => 1_800_000_000_000,
      ),
    ).toEqual({ complete: true, nextWakeAtMs: 1_700_000_000_000 });
    expect(
      combineGatewaySuspendWakeSnapshot({ complete: true, nextWakeAtMs: null }, () => null),
    ).toEqual({ complete: true, nextWakeAtMs: null });
  });

  it("fails closed when either wake snapshot is incomplete", () => {
    expect(combineGatewaySuspendWakeSnapshot({ complete: false }, vi.fn())).toEqual({
      complete: false,
    });
    expect(
      combineGatewaySuspendWakeSnapshot({ complete: true, nextWakeAtMs: null }, () => {
        throw new Error("queue read failed");
      }),
    ).toEqual({ complete: false });
  });
});
