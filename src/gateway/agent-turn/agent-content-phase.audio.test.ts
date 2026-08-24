import { beforeEach, describe, expect, it, vi } from "vitest";

const applyMediaUnderstandingMock = vi.hoisted(() => vi.fn());

vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: applyMediaUnderstandingMock,
}));

import { applyAgentAudioUnderstanding } from "./agent-audio-understanding.js";

describe("agent RPC audio understanding", () => {
  beforeEach(() => {
    applyMediaUnderstandingMock.mockReset();
  });

  it("runs the upstream audio-only media pipeline and returns its prompt", async () => {
    applyMediaUnderstandingMock.mockImplementation(async ({ ctx }) => {
      ctx.Body = "[Audio]\nUser text:\n[Telegram attachment]\nTranscript:\nhello from voice";
      ctx.BodyForAgent = ctx.Body;
      return { appliedAudio: true };
    });

    const result = await applyAgentAudioUnderstanding({
      cfg: { tools: { media: { audio: { enabled: true } } } },
      agentId: "main",
      sessionKey: "agent:main:main",
      channel: "arxi",
      message: "[Telegram attachment]",
      media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" }],
    });

    expect(result).toEqual({
      applied: true,
      message: "[Audio]\nUser text:\n[Telegram attachment]\nTranscript:\nhello from voice",
    });
    expect(applyMediaUnderstandingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        processingMode: "audio-only",
        selfServeLocalPaths: false,
        agentId: "main",
        ctx: expect.objectContaining({
          Body: "[Audio]\nUser text:\n[Telegram attachment]\nTranscript:\nhello from voice",
          Provider: "arxi",
          SessionKey: "agent:main:main",
          media: [expect.objectContaining({ contentType: "audio/ogg", kind: "audio" })],
        }),
      }),
    );
  });

  it("does not load the media pipeline for non-audio attachments", async () => {
    const result = await applyAgentAudioUnderstanding({
      cfg: {},
      message: "photo",
      media: [{ path: "/tmp/photo.png", contentType: "image/png", kind: "image" }],
    });

    expect(result).toEqual({ applied: false, message: "photo" });
    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();
  });

  it("does not load the media pipeline when audio understanding is disabled", async () => {
    const result = await applyAgentAudioUnderstanding({
      cfg: { tools: { media: { audio: { enabled: false } } } },
      message: "voice",
      media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" }],
    });

    expect(result).toEqual({ applied: false, message: "voice" });
    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();
  });
});
