import { describe, expect, it } from "vitest";
import { projectTelegramExternalMessageContext } from "./external-context-projection.js";

describe("external Telegram context projection", () => {
  it("normalizes structured reply and forward facts into Telegram model context", () => {
    const projected = projectTelegramExternalMessageContext({
      message: "what does this mean?",
      reply: {
        messageId: "7",
        body: "referenced image",
        sender: { displayName: "Owner" },
        mediaKind: "photo",
      },
      items: [
        {
          messageId: "8",
          text: "forwarded body",
          forwardOrigin: { type: "hidden_user", sender_user_name: "Unverified", date: 123 },
          media: [{ kind: "document", disposition: "unsupported" }],
        },
      ],
    });

    expect(projected).toContain("[Replying to Owner id:7]");
    expect(projected).toContain("<media:image>");
    expect(projected).toContain("[Forwarded from Unverified at 1970-01-01T00:02:03.000Z]");
    expect(projected).toContain("[Unsupported Telegram document: contents unavailable]");
    expect(projected).not.toContain("forward_origin");
  });

  it("rejects malformed origins instead of inventing provenance", () => {
    expect(() =>
      projectTelegramExternalMessageContext({
        message: "x",
        items: [{ messageId: "1", text: "x", forwardOrigin: { type: "hidden_user" } }],
      }),
    ).toThrow("forward origin");
  });
});
