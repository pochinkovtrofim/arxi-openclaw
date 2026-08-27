import { describe, expect, it } from "vitest";
import { buildUnknownSendContext } from "./delivery-queue-reconciliation.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

function entry(
  payload: { text: string; mediaUrl?: string; isStatusNotice?: boolean },
  overrides: { forceDocument?: boolean } = {},
  replyKind: "final" | null = "final",
) {
  const preparedBatch = createUnmodifiedPreparedOutboundBatch([payload]);
  preparedBatch.runId = "run-exact";
  if (replyKind) {
    preparedBatch.replyKind = replyKind;
  }
  return {
    id: "queue-1",
    channel: "arxi",
    to: "owner",
    enqueuedAt: 1,
    retryCount: 1,
    preparedBatch,
    ...overrides,
  };
}

describe("unknown-send source correlation", () => {
  it("retains a useful final run across durable recovery", () => {
    const payload = { text: "useful answer" };
    expect(
      buildUnknownSendContext({ entry: entry(payload), payloads: [payload], cfg: {} }),
    ).toMatchObject({ sourceRunId: "run-exact" });
  });

  it("retains a model-authored media run across durable recovery", () => {
    const payload = { text: "artifact", mediaUrl: "https://example.com/artifact.txt" };
    expect(
      buildUnknownSendContext({ entry: entry(payload, {}, null), payloads: [payload], cfg: {} }),
    ).toMatchObject({ sourceRunId: "run-exact" });
  });

  it("does not classify a status notice as a useful result", () => {
    const payload = { text: "working", isStatusNotice: true };
    expect(
      buildUnknownSendContext({ entry: entry(payload), payloads: [payload], cfg: {} }),
    ).not.toHaveProperty("sourceRunId");
  });

  it.each([true, false])("retains forceDocument=%s across durable recovery", (forceDocument) => {
    const payload = { text: "caption" };
    expect(
      buildUnknownSendContext({
        entry: entry(payload, { forceDocument }),
        payloads: [payload],
        cfg: {},
      }),
    ).toMatchObject({ forceDocument });
  });
});
