import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SnapshotSchema } from "./snapshot.js";

function snapshotWithPresence(presence: Record<string, unknown>) {
  return {
    presence: [presence],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
  };
}

describe("SnapshotSchema", () => {
  it.each(["accepting"])("accepts public suspension phase %s without lease tokens", (phase) => {
    const snapshot = { ...snapshotWithPresence({ ts: 1 }), suspension: { phase } };
    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(SnapshotSchema, {
        ...snapshot,
        suspension: { phase, suspensionId: "private-token" },
      }),
    ).toBe(false);
  });

  it.each([
    { complete: true, pendingCount: 2, futureDeferredCount: 1, earliestDeferredUntilMs: 3_000 },
    { complete: false },
  ])("accepts a content-free outbound queue inventory %o", (outbound) => {
    const snapshot = {
      ...snapshotWithPresence({ ts: 1 }),
      health: { deliveryQueues: { failed: [], outbound } },
    };

    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
  });
});
