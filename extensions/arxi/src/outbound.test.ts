import { afterEach, describe, expect, it, vi } from "vitest";
import { arxiMessageAdapter, reactionActionId, reconcile, sendText } from "./outbound.js";

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

  it("uses the core queue identity and stable provider-part identities for multiple media", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/action-files/")) {
        return new Response(JSON.stringify({ size_bytes: 3, sha256: "a".repeat(64) }), {
          status: 200,
        });
      }
      if (url.endsWith("/v1/actions")) {
        actions.push(JSON.parse(typeof init?.body === "string" ? init.body : ""));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const sendPayload = arxiMessageAdapter.send?.payload;
    if (!sendPayload) {
      throw new Error("Arxi payload adapter is missing");
    }
    const request = {
      cfg: {} as never,
      to: "owner",
      text: "caption",
      payload: { text: "caption", mediaUrls: ["/tmp/a.png", "/tmp/b.png"] },
      deliveryQueueId: "delivery-media",
      mediaLocalRoots: "any" as const,
      mediaReadFile: async () =>
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
    };
    const first = await sendPayload(request);
    const replay = await sendPayload(request);

    expect(first.receipt.platformMessageIds).toHaveLength(2);
    expect(replay.receipt.platformMessageIds).toEqual(first.receipt.platformMessageIds);
    expect(first.receipt.platformMessageIds[0]).toBe("delivery-media");
    expect(first.receipt.platformMessageIds[1]).toMatch(/^media:[0-9a-f]{64}$/u);
    expect(actions.map((action) => action.action_id)).toEqual([
      ...first.receipt.platformMessageIds,
      ...first.receipt.platformMessageIds,
    ]);
    expect(actions.map((action) => (action.payload as { caption?: string }).caption)).toEqual([
      "caption",
      "",
      "caption",
      "",
    ]);
  });

  it("reconciles the rendered text and hook-mutated reply target", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcile({
      cfg: {} as never,
      queueId: "delivery-reply-recovery",
      channel: "arxi",
      to: "owner",
      enqueuedAt: 1,
      retryCount: 1,
      replyToId: "41",
      effectiveReplyToId: "42",
      payloads: [{ text: "pre-hook text" }],
      renderedBatchPlan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 0,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [{ index: 0, kinds: ["text"], text: "post-hook text", mediaUrls: [] }],
      },
    });

    expect(result.status).toBe("sent");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(typeof init.body === "string" ? init.body : "")).toMatchObject({
      action_id: "delivery-reply-recovery",
      payload: { text: "post-hook text", reply_to_message_id: 42 },
    });
  });

  it("reconciles media from the durable rendered plan after restart", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const mediaReadFile = vi.fn(async () =>
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/action-files/")) {
        return new Response(JSON.stringify({ size_bytes: 3, sha256: "b".repeat(64) }), {
          status: 200,
        });
      }
      actions.push(JSON.parse(typeof init?.body === "string" ? init.body : ""));
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcile({
      cfg: {} as never,
      queueId: "delivery-media-recovery",
      channel: "arxi",
      to: "owner",
      enqueuedAt: 1,
      retryCount: 1,
      replyToId: "41",
      effectiveReplyToId: null,
      payloads: [{ text: "old caption", mediaUrl: "/tmp/expired.png" }],
      renderedBatchPlan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 1,
        voiceCount: 1,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [
          {
            index: 0,
            kinds: ["text", "voice"],
            text: "durable caption",
            mediaUrls: ["/tmp/durable-spool.png"],
            audioAsVoice: true,
          },
        ],
      },
      mediaLocalRoots: "any",
      mediaReadFile,
    });

    expect(result.status).toBe("sent");
    expect(mediaReadFile).toHaveBeenCalledWith("/tmp/durable-spool.png");
    expect(mediaReadFile).not.toHaveBeenCalledWith("/tmp/expired.png");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action_id: "delivery-media-recovery",
      payload: { caption: "durable caption", media_kind: 5 },
    });
    expect(actions[0]?.payload).not.toHaveProperty("reply_to_message_id");
  });

  it("terminally refuses an unsupported durable batch before partial replay", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcile({
      cfg: {} as never,
      queueId: "delivery-batch-recovery",
      channel: "arxi",
      to: "owner",
      enqueuedAt: 1,
      retryCount: 1,
      payloads: [{ text: "first" }, { text: "second" }],
    });

    expect(result).toMatchObject({ status: "unresolved", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
