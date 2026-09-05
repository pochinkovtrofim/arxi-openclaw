import { describe, expect, it } from "vitest";
import { attachmentClassFromMime, classifyAttachmentBytes } from "./attachment-classify.js";
import { normalizeMimeType } from "./mime.js";

describe("attachmentClassFromMime", () => {
  it.each([
    ["text/plain", "text"],
    ["application/vnd.api+json", "text"],
    ["application/pdf", "document"],
    ["application/msword", "document"],
    ["application/rtf", "document"],
    ["text/rtf", "document"],
    ["application/epub+zip", "document"],
    ["image/png", "image"],
    ["audio/mpeg", "audio"],
    ["video/mp4", "video"],
    ["application/zip", "archive"],
    ["application/octet-stream", "binary"],
  ] as const)("classifies %s as %s", (mime, expected) => {
    expect(attachmentClassFromMime(mime)).toBe(expected);
  });
});

describe("classifyAttachmentBytes", () => {
  it.each([
    { name: "misleading.txt", declaredMime: "text/plain", mime: "application/x-cfb" },
    { name: "legacy.doc", declaredMime: "text/plain", mime: "application/msword" },
    {
      name: "legacy.bin",
      declaredMime: "application/vnd.ms-excel",
      mime: "application/vnd.ms-excel",
    },
  ])("never decodes compound bytes as text ($name)", async ({ name, declaredMime, mime }) => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.from("d0cf11e0a1b11ae1", "hex"),
        name,
        declaredMime,
      }),
    ).resolves.toEqual({ mime, class: "document" });
  });

  it("routes RTF bytes into document extraction despite a text MIME and name", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.from("{\\rtf1 bounded document}"),
        name: "notes.txt",
        declaredMime: "text/plain",
      }),
    ).resolves.toEqual({ mime: "application/rtf", class: "document" });
  });
  it("infers delimited text from otherwise untyped bytes", async () => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("name,value\nopenclaw,1"), name: "data.bin" }),
    ).resolves.toEqual({ mime: "text/csv", class: "text" });
  });

  it("returns the UTF-16 charset with text classification", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")]),
        name: "notes.bin",
      }),
    ).resolves.toEqual({ mime: "text/plain", class: "text", charset: "utf-16le" });
  });

  it("keeps the charset when a BOM-less UTF-16 file resolves text by extension", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.from("meeting notes for tomorrow", "utf16le"),
        name: "notes.txt",
      }),
    ).resolves.toEqual({ mime: "text/plain", class: "text", charset: "utf-16le" });
  });

  it("keeps byte-detected media ahead of a text filename", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
      "base64",
    );
    await expect(classifyAttachmentBytes({ buffer: png, name: "spoof.txt" })).resolves.toEqual({
      mime: "image/png",
      class: "image",
    });
  });

  it("does not let a text filename override ZIP bytes", async () => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("PK\u0003\u0004payload"), name: "spoof.txt" }),
    ).resolves.toEqual({ mime: "application/zip", class: "archive" });
  });

  it("keeps declared octet-stream content binary without a text extension", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.from("printable but explicitly binary"),
        declaredMime: "application/octet-stream",
        name: "payload.bin",
      }),
    ).resolves.toEqual({ mime: "application/octet-stream", class: "binary" });
  });

  it.each([
    ["config.yaml", "application/yaml"],
    ["payload.xml", "text/xml"],
    ["debug.log", "text/plain"],
    ["settings.ini", "text/plain"],
  ] as const)("uses the canonical extension MIME for %s", async (name, mime) => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("key=value"), name }),
    ).resolves.toEqual({ mime, class: "text" });
  });
});

describe("mime synonym folding", () => {
  it("matches a configured text/yaml allowlist against classified .yaml files", async () => {
    const classified = await classifyAttachmentBytes({
      buffer: Buffer.from("key: value\nitems:\n  - one\n", "utf8"),
      name: "config.yaml",
    });
    expect(classified.mime).toBe("application/yaml");
    expect(normalizeMimeType("text/yaml")).toBe(classified.mime);
    expect(normalizeMimeType("application/xml")).toBe("text/xml");
  });
});
