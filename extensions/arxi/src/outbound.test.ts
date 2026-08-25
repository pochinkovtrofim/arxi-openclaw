import { afterEach, describe, expect, it, vi } from "vitest";
import { reactionActionId, sendText } from "./outbound.js";

afterEach(() => vi.unstubAllGlobals());

describe("Arxi durable outbound", () => {
  it("submits semantic markdown with the durable queue identity", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendText({
      cfg: {} as never,
      to: "owner",
      text: "**hello**",
      deliveryQueueId: "delivery-1",
      sourceRunId: "run-1",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(typeof init.body === "string" ? init.body : "")).toEqual({
      version: 2,
      action_id: "delivery-1",
      source_run_id: "run-1",
      kind: 1,
      payload: { text: "**hello**", format: 1 },
    });
  });

  it("refuses a foreign target before a platform write", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      sendText({ cfg: {} as never, to: "other", text: "secret", deliveryQueueId: "delivery-2" }),
    ).rejects.toThrow(/only owner/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives replay-stable distinct reaction identities", () => {
    expect(reactionActionId(42, "👍")).toBe(reactionActionId(42, "👍"));
    expect(reactionActionId(42, "👍")).not.toBe(reactionActionId(43, "👍"));
  });
});
