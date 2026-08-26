import { describe, expect, it } from "vitest";
import { projectTelegramExternalMessageContext } from "./external-context-projection.js";

describe("external Telegram context projection", () => {
  it("normalizes structured reply and forward facts into Telegram model context", () => {
    const projected = projectTelegramExternalMessageContext({
      message: "what does this mean?",
      reply: {
        messageId: "7",
        body: "referenced image",
        sender: { displayName: "Owner", id: "42", username: "owner" },
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

    expect(projected).toContain("[1. Owner id:7]");
    expect(projected).toContain(
      "[Sender evidence sender_id:42 sender_username:@owner sender_evidence:stable-id]",
    );
    expect(projected).toContain("<media:image>");
    expect(projected).toContain("[Forwarded from Unverified at 1970-01-01T00:02:03.000Z]");
    expect(projected).toContain("[Unsupported Telegram document: contents unavailable]");
    expect(projected).not.toContain("forward_origin");
  });

  it("keeps a selected quote focused alongside its body and every sender fact", () => {
    const projected = projectTelegramExternalMessageContext({
      message: "answer the highlighted sentence",
      reply: {
        messageId: "71",
        quote: "the selected sentence",
        body: "before the selection, the selected sentence, and after it",
        sender: { displayName: "Display Name", id: "12345", username: "stable_handle" },
      },
    });

    expect(projected).toContain('[Selected quote]\n"the selected sentence"');
    expect(projected).toContain(
      "[Surrounding reply body]\nbefore the selection, the selected sentence, and after it",
    );
    expect(projected).toContain("Display Name");
    expect(projected).toContain("sender_id:12345");
    expect(projected).toContain("sender_username:@stable_handle");
    expect(projected).toContain("sender_evidence:stable-id");
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
