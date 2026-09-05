import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { DocumentExtractionError } from "openclaw/plugin-sdk/document-extractor";
import { describe, expect, it } from "vitest";
import { createOfficeDocumentExtractor } from "./document-extractor.js";

const fixtureRoot = new URL("./fixtures/anydoc-0.2.4/", import.meta.url);
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function extractFixture(path: string, mimeType: string, maxChars = 60_000) {
  const buffer = await readFile(new URL(path, fixtureRoot));
  return createOfficeDocumentExtractor().extract({
    buffer,
    mimeType,
    maxChars,
    timeoutMs: 10_000,
    maxPages: 4,
    maxPixels: 4_000_000,
    minTextChars: 200,
  });
}

describe("bounded local Office extraction through the bundled native binding", () => {
  it.each([
    ["doc/text.doc", "application/msword", "# Fixture Document", "| Tall | B2 | C2 |"],
    ["docx/text.docx", docxMime, "# Fixture Document", "Inside the text box."],
    [
      "ppt/pres.ppt",
      "application/vnd.ms-powerpoint",
      "Numbers Slide",
      "> Speaker note for the intro slide.",
    ],
    [
      "pptx/pres.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Deck Title Slide",
      "| North | 42 |",
    ],
    [
      "xls/sheet.xls",
      "application/vnd.ms-excel",
      "## Values",
      "| Duration | 26:30:15 | over a day |",
    ],
    [
      "xlsx/sheet.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "## Values",
      "| Duration | 26:30:15 | over a day |",
    ],
    [
      "xlsb/handmade-sheet.xlsb",
      "application/vnd.ms-excel.sheet.binary.macroenabled.12",
      "| 42 | 65.0% | $1,234.50 |",
      "wide merge",
    ],
    [
      "odt/text.odt",
      "application/vnd.oasis.opendocument.text",
      "# Fixture Document",
      "| Tall | B2 | C2 |",
    ],
    [
      "ods/sheet.ods",
      "application/vnd.oasis.opendocument.spreadsheet",
      "## Values",
      "| Duration | 26:30:15 | over a day |",
    ],
    [
      "odp/pres.odp",
      "application/vnd.oasis.opendocument.presentation",
      "Deck Title Slide",
      "| North | 42 |",
    ],
    ["rtf/text.rtf", "application/rtf", "# Fixture Document", "| Tall | B2 | C2 |"],
    ["epub/book.epub", "application/epub+zip", "# Chapter One", "| Bolts | 12 |"],
  ])(
    "reads meaningful structure from %s with no embedded vision claim",
    async (path, mime, first, second) => {
      const result = await extractFixture(path, mime);
      expect(result?.text).toContain(first);
      expect(result?.text).toContain(second);
      expect(result?.images).toEqual([]);
    },
  );

  it.each([
    [
      "docx/text.docx",
      "application/vnd.ms-word.document.macroenabled.12",
      "word/document.xml",
      "application/vnd.ms-word.document.macroEnabled.main+xml",
      "Fixture Document",
    ],
    [
      "pptx/pres.pptx",
      "application/vnd.ms-powerpoint.presentation.macroenabled.12",
      "ppt/presentation.xml",
      "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
      "Deck Title Slide",
    ],
    [
      "xlsx/sheet.xlsx",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "xl/workbook.xml",
      "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
      "## Values",
    ],
  ])(
    "reads the macro-enabled container variant of %s as data",
    async (path, mimeType, part, contentType, marker) => {
      const archive = await JSZip.loadAsync(await readFile(new URL(path, fixtureRoot)));
      const types = await archive.file("[Content_Types].xml")?.async("string");
      expect(types).toBeTruthy();
      const parsed = types!.replace(
        new RegExp(`(<Override[^>]+PartName="/${part}"[^>]+ContentType=")[^"]+`),
        `$1${contentType}`,
      );
      expect(parsed).not.toBe(types);
      archive.file("[Content_Types].xml", parsed);
      const result = await createOfficeDocumentExtractor().extract({
        buffer: await archive.generateAsync({ type: "nodebuffer" }),
        mimeType,
        maxChars: 60_000,
        timeoutMs: 10_000,
        maxPages: 4,
        maxPixels: 4_000_000,
        minTextChars: 200,
      });
      expect(result?.text).toContain(marker);
    },
  );

  it("reads a real embedded VBA project without applying its document mutation", async () => {
    const macroRoot = new URL("./fixtures/apache-poi/", import.meta.url);
    const archive = await JSZip.loadAsync(await readFile(new URL("SimpleMacro.docm", macroRoot)));
    const project = await archive.file("word/vbaProject.bin")?.async("nodebuffer");
    expect(project?.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
    const macroEffect = "This is a macro word processing document";
    expect(await readFile(new URL("SimpleMacro.vba", macroRoot), "utf8")).toContain(macroEffect);
    const document = await archive.file("word/document.xml")!.async("string");
    expect(document).toContain(macroEffect);
    archive.file(
      "word/document.xml",
      document.replace(macroEffect, "Document before macro execution"),
    );
    const result = await createOfficeDocumentExtractor().extract({
      buffer: await archive.generateAsync({ type: "nodebuffer" }),
      mimeType: "application/vnd.ms-word.document.macroenabled.12",
      maxPages: 4,
      maxPixels: 4_000_000,
      minTextChars: 200,
    });
    expect(result?.text).toContain("Document before macro execution");
    expect(result?.text).not.toContain(macroEffect);
  });

  it("does not execute an EPUB script with file, process and network side effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "office-script-canary-"));
    const fileMarker = join(directory, "script-file");
    const processMarker = join(directory, "script-process");
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end("synthetic");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("script canary listener did not bind");
      }
      const archive = await JSZip.loadAsync(await readFile(new URL("epub/book.epub", fixtureRoot)));
      const chapterPath = "EPUB/text/ch001.xhtml";
      const chapter = await archive.file(chapterPath)!.async("string");
      const script = `<script><![CDATA[
        try { require('node:fs').writeFileSync(${JSON.stringify(fileMarker)}, 'executed'); } catch {}
        try { require('node:child_process').spawnSync('/usr/bin/touch', [${JSON.stringify(processMarker)}]); } catch {}
        try { fetch('http://127.0.0.1:${address.port}/embedded-script').catch(() => {}); } catch {}
      ]]></script>`;
      expect(chapter).toContain("</body>");
      archive.file(chapterPath, chapter.replace("</body>", `${script}</body>`));
      const result = await createOfficeDocumentExtractor().extract({
        buffer: await archive.generateAsync({ type: "nodebuffer" }),
        mimeType: "application/epub+zip",
        maxPages: 4,
        maxPixels: 4_000_000,
        minTextChars: 200,
      });
      expect(result?.text).toContain("Chapter One");
      expect(result?.text).not.toContain("spawnSync");
      await expect(stat(fileMarker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(processMarker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["malformed/empty--errors.docx", docxMime],
    ["malformed/truncated--errors.doc", "application/msword"],
    ["malformed/truncated--errors.docx", docxMime],
    ["malformed/encrypted--errors.odt", "application/vnd.oasis.opendocument.text"],
    ["abuse/zipbomb--errors.docx", docxMime],
    ["abuse/deepxml--errors.docx", docxMime],
    ["abuse/deepnest--errors.ppt", "application/vnd.ms-powerpoint"],
    [
      "abuse/hugespan--errors.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["abuse/hugerepeat--errors.ods", "application/vnd.oasis.opendocument.spreadsheet"],
  ])(
    "rejects %s with one content-free failure and allows the next document",
    async (path, mime) => {
      await expect(extractFixture(path, mime)).rejects.toBeInstanceOf(DocumentExtractionError);
      const next = await extractFixture("rtf/text.rtf", "application/rtf", 100);
      expect(next?.text).toContain("Fixture Document");
    },
  );

  it("keeps a parser-detected password limitation explicit", async () => {
    await expect(
      extractFixture("malformed/encrypted--errors.odt", "application/vnd.oasis.opendocument.text"),
    ).rejects.toMatchObject({ code: "encrypted" });
  });

  it("clamps text before returning it and never converts PDF or CSV", async () => {
    const small = await extractFixture("docx/text.docx", docxMime, 21);
    expect(small?.text.length).toBeLessThanOrEqual(21);
    const extractor = createOfficeDocumentExtractor();
    expect(extractor.mimeTypes).not.toContain("application/pdf");
    expect(extractor.mimeTypes).not.toContain("text/csv");
  });

  it("does not launch conversion after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createOfficeDocumentExtractor().extract({
        buffer: await readFile(new URL("docx/text.docx", fixtureRoot)),
        mimeType: docxMime,
        signal: controller.signal,
        maxPages: 4,
        maxPixels: 4_000_000,
        minTextChars: 200,
      }),
    ).rejects.toMatchObject({ code: "canceled" });
  });

  it("kills and reaps an active stopped child on cancellation, then accepts another document", async () => {
    const tasksPath = `/proc/${process.pid}/task`;
    const children = async () => {
      // Vitest can run this test in a worker thread; Linux attributes spawned
      // children to that thread rather than the process's initial thread.
      const lists = await Promise.all(
        (await readdir(tasksPath)).map(async (tid) => {
          try {
            return await readFile(`${tasksPath}/${tid}/children`, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return "";
            }
            throw error;
          }
        }),
      );
      return lists.join(" ").trim().split(/\s+/).filter(Boolean).map(Number);
    };
    const before = new Set(await children());
    const controller = new AbortController();
    const buffer = await readFile(new URL("docx/text.docx", fixtureRoot));
    const pending = createOfficeDocumentExtractor().extract({
      buffer,
      mimeType: docxMime,
      signal: controller.signal,
      maxPages: 4,
      maxPixels: 4_000_000,
      minTextChars: 200,
    });
    // Attach rejection handling before aborting. Observe and stop the actual
    // child so this exercises active cancellation rather than a preflight race.
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    let child: number | undefined;
    try {
      const deadline = performance.now() + 1_000;
      while (!child && performance.now() < deadline) {
        child = (await children()).find((pid) => !before.has(pid));
        if (!child) {
          await nextTurn();
        }
      }
      expect(child).toBeDefined();
      process.kill(child!, "SIGSTOP");
      controller.abort();
      expect(await outcome).toMatchObject({ code: "canceled" });
      expect(() => process.kill(child!, 0)).toThrow();
    } finally {
      controller.abort();
      await outcome;
    }
    expect((await extractFixture("rtf/text.rtf", "application/rtf"))?.text).toContain(
      "Fixture Document",
    );
  });

  it("enforces the deadline and releases the conversion slot", async () => {
    await expect(
      createOfficeDocumentExtractor().extract({
        buffer: await readFile(new URL("docx/text.docx", fixtureRoot)),
        mimeType: docxMime,
        timeoutMs: 1,
        maxPages: 4,
        maxPixels: 4_000_000,
        minTextChars: 200,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect((await extractFixture("rtf/text.rtf", "application/rtf"))?.text).toContain(
      "Fixture Document",
    );
  });

  it("does not expose unsupported bytes or their filename in an error", async () => {
    const secret = "private-document-canary-not-for-errors";
    try {
      await createOfficeDocumentExtractor().extract({
        buffer: Buffer.from(secret),
        mimeType: docxMime,
        maxPages: 4,
        maxPixels: 4_000_000,
        minTextChars: 200,
      });
      expect.fail("unsupported bytes were accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentExtractionError);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(fileURLToPath(fixtureRoot));
    }
  });
});
