import { describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { classifyAttachmentBytes } from "./media-mime.js";
import {
  describeReplyTarget,
  normalizeForwardedContext,
  planTelegramCaption,
  planTelegramPhotoDocumentDelivery,
  planTelegramTextDeliveryPages,
  TELEGRAM_EMPTY_CONTENT_ERROR_PATTERN,
  TELEGRAM_PHOTO_DOCUMENT_ERROR_PATTERN,
} from "./telegram-runtime.js";

describe("telegram runtime SDK contract", () => {
  it("plans formatted text and its exact plain fallback before delivery", () => {
    expect(planTelegramTextDeliveryPages({ text: "Hello **owner**", maxChars: 4096 })).toEqual([
      {
        htmlText: "Hello <b>owner</b>",
        plainText: "Hello owner",
        sourceText: "Hello <b>owner</b>",
        sourceTextMode: "html",
      },
    ]);
    expect(
      new RegExp(TELEGRAM_EMPTY_CONTENT_ERROR_PATTERN, "i").test(
        "Bad Request: message text is empty",
      ),
    ).toBe(true);
  });

  it("plans captions and preserves an over-limit caption as following text", () => {
    expect(planTelegramCaption({ text: "Hello **owner**" })).toEqual({
      caption: "Hello **owner**",
      htmlCaption: "Hello <b>owner</b>",
      plainCaption: "Hello **owner**",
    });

    const overLimit = "x".repeat(1025);
    expect(planTelegramCaption({ text: overLimit })).toEqual({ followUpText: overLimit });
  });

  it("plans an eligible image as a photo with an exact document fallback", async () => {
    const bytes = createSolidPngBuffer(2, 2, { r: 24, g: 96, b: 208 });
    const plan = await planTelegramPhotoDocumentDelivery({
      bytes,
      fileName: "result.png",
      text: "**Done**",
    });

    expect(plan).toEqual({
      kind: "photo",
      photoFallbackKind: "document",
      fileName: "result.png",
      mediaType: "image/png",
      caption: "<b>Done</b>",
      fallbackCaption: "**Done**",
    });
    expect(
      new RegExp(TELEGRAM_PHOTO_DOCUMENT_ERROR_PATTERN, "i").test(
        "Bad Request: PHOTO_INVALID_DIMENSIONS",
      ),
    ).toBe(true);
  });

  it("keeps explicit document intent and byte classification exact", async () => {
    const bytes = createSolidPngBuffer(2, 2, { r: 208, g: 64, b: 24 });
    expect(await classifyAttachmentBytes({ buffer: bytes, name: "misleading.pdf" })).toMatchObject({
      class: "image",
      mime: "image/png",
    });
    await expect(
      planTelegramPhotoDocumentDelivery({
        bytes,
        fileName: "misleading.pdf",
        forceDocument: true,
      }),
    ).resolves.toEqual({
      kind: "document",
      fileName: "misleading.pdf",
      mediaType: "image/png",
    });
  });

  it("keeps unsupported photo geometry and ordinary artifacts on the document path", async () => {
    const tooNarrow = createSolidPngBuffer(1, 30, { r: 32, g: 64, b: 96 });
    await expect(
      planTelegramPhotoDocumentDelivery({ bytes: tooNarrow, fileName: "narrow.png" }),
    ).resolves.toMatchObject({
      kind: "document",
      fileName: "narrow.png",
      mediaType: "image/png",
    });

    const pdf = Buffer.from("%PDF-1.7\n% pinned fixture\n", "utf8");
    await expect(
      planTelegramPhotoDocumentDelivery({ bytes: pdf, fileName: "report.pdf" }),
    ).resolves.toMatchObject({
      kind: "document",
      fileName: "report.pdf",
      mediaType: "application/pdf",
    });
  });

  it("normalizes pinned direct-reply and forward provenance", () => {
    const reply = describeReplyTarget({
      reply_to_message: {
        message_id: 7,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Owner" },
        caption: "referenced image",
        photo: [{ file_id: "photo", file_unique_id: "unique", width: 2, height: 2 }],
      },
    } as Parameters<typeof describeReplyTarget>[0]);
    expect(reply).toMatchObject({
      id: "7",
      sender: "Owner",
      senderId: "42",
      body: "referenced image",
      mediaType: "image",
      source: "reply_to_message",
    });

    const forwarded = normalizeForwardedContext({
      forward_origin: {
        type: "hidden_user",
        sender_user_name: "Unverified Sender",
        date: 123,
      },
    } as Parameters<typeof normalizeForwardedContext>[0]);
    expect(forwarded).toEqual({
      from: "Unverified Sender",
      fromType: "hidden_user",
      fromTitle: "Unverified Sender",
      date: 123,
    });
    expect(forwarded).not.toHaveProperty("fromId");
  });
});
