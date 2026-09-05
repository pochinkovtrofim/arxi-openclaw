import { createRequire } from "node:module";
import {
  OFFICE_DOCUMENT_FORMATS,
  DocumentExtractionError,
  officeDocumentFormat,
  type DocumentExtractionRequest,
  type DocumentExtractionResult,
  type DocumentExtractorPlugin,
} from "openclaw/plugin-sdk/document-extractor";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";

const require = createRequire(import.meta.url);
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 60_000;
const MAX_TIMEOUT_MS = 10_000;
// AnyDoc names the entire Excel family "xlsx". Keep binding-specific names
// inside the plugin; media-core only describes MIME, extension and container.
const ANYDOC_FORMAT_BY_EXTENSION = {
  ".doc": "doc",
  ".docx": "docx",
  ".docm": "docx",
  ".ppt": "ppt",
  ".pptx": "pptx",
  ".pptm": "pptx",
  ".xls": "xlsx",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".xlsb": "xlsx",
  ".odt": "odt",
  ".ods": "ods",
  ".odp": "odp",
  ".rtf": "rtf",
  ".epub": "epub",
} as const;
let conversionActive = false;

// Both native detection and conversion run beyond the Gateway process. AnyDoc
// exposes no cancellation; killing a JS promise/worker leaves libuv native work.
// This program never loads the hosted-OCR wrapper or accepts a document path.
const CONVERT_BYTES = String.raw`
const binding = require(process.argv[1]);
const expected = process.argv[2];
const maxChars = Number(process.argv[3]);
const maxBytes = Number(process.argv[4]);
const container = process.argv[5];
const chunks = [];
let size = 0;
(async () => {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) process.exit(2);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    const signature = container === 'cfb' ? Buffer.from('d0cf11e0a1b11ae1', 'hex') : container === 'zip' ? Buffer.from([80, 75, 3, 4]) : Buffer.from('{\\rtf');
    if (!bytes.subarray(0, signature.length).equals(signature)) {
      process.stdout.write(JSON.stringify({ error: 'unsupported' }));
      return;
    }
    const actual = binding.formatFromBytes(bytes);
    if (actual && actual !== expected) {
      process.stdout.write(JSON.stringify({ error: 'unsupported' }));
      return;
    }
    // Detection intentionally hides corrupt/encrypted-container errors. An
    // explicit family after the byte-signature gate lets parsing report them.
    const markdown = await binding.toMarkdownBytes(bytes, actual ?? expected);
    let text = markdown.slice(0, maxChars);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    process.stdout.write(JSON.stringify({ text }));
  } catch (error) {
    const codes = ['encrypted', 'malformed', 'missingPart', 'unsupported', 'resourceLimit', 'io'];
    process.stdout.write(JSON.stringify({ error: codes.includes(error?.code) ? error.code : 'io' }));
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
})().catch(() => process.exit(2));
`;

async function extractOfficeContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const format = officeDocumentFormat(request.mimeType);
  if (request.signal?.aborted) {
    throw new DocumentExtractionError("canceled");
  }
  // RLIMIT_NPROC is not enforced for real UID 0. Fail closed rather than
  // silently lose the task budget when a caller runs its Gateway as root.
  if (!format || process.platform !== "linux" || process.getuid?.() === 0) {
    throw new DocumentExtractionError("unavailable");
  }
  if (request.buffer.length === 0) {
    throw new DocumentExtractionError("malformed");
  }
  if (request.buffer.length > MAX_INPUT_BYTES || conversionActive) {
    throw new DocumentExtractionError("resourceLimit");
  }
  const maxChars = Math.max(
    1,
    Math.min(MAX_OUTPUT_CHARS, Math.floor(request.maxChars ?? MAX_OUTPUT_CHARS)),
  );
  const timeoutMs = Math.max(
    1,
    Math.min(MAX_TIMEOUT_MS, Math.floor(request.timeoutMs ?? MAX_TIMEOUT_MS)),
  );
  if (!Number.isFinite(maxChars) || !Number.isFinite(timeoutMs)) {
    throw new Error("Invalid local document extraction limits.");
  }
  // One native allocation budget per Gateway; concurrent calls fail visibly
  // instead of retaining private bytes in an unbounded conversion queue.
  conversionActive = true;
  try {
    // RLIMIT_DATA bounds native malloc/mmap (Linux >=4.7), unlike the V8 heap
    // flag. No usable network interfaces, credentials, inherited loader
    // overrides, writable output files, or core dumps are supplied to conversion.
    const result = await runCommandWithTimeout(
      [
        "/usr/bin/unshare",
        "--user",
        "--map-current-user",
        "--net",
        "--",
        "/usr/bin/setpriv",
        "--no-new-privs",
        "--bounding-set=-all",
        "--",
        "/usr/bin/prlimit",
        "--data=805306368:805306368",
        "--core=0:0",
        "--fsize=0:0",
        "--cpu=10:10",
        "--nofile=64:64",
        "--nproc=32:32",
        "--",
        process.execPath,
        "--max-old-space-size=128",
        "--input-type=commonjs",
        "-e",
        CONVERT_BYTES,
        require.resolve("@firecrawl/anydoc/index.js"),
        ANYDOC_FORMAT_BY_EXTENSION[format.extension],
        String(maxChars),
        String(request.buffer.length),
        format.container,
      ],
      {
        input: request.buffer,
        baseEnv: {},
        env: { UV_THREADPOOL_SIZE: "1" },
        cwd: "/",
        signal: request.signal,
        timeoutMs,
        killProcessTree: true,
        killSignal: "SIGKILL",
        killGraceMs: 0,
        maxOutputBytes: { stdout: maxChars * 6 + 64, stderr: 1024 },
        outputCapture: { stdout: "head", stderr: "discard" },
        terminateOnOutputLimit: true,
      },
    );
    if (
      result.code !== 0 ||
      result.termination !== "exit" ||
      result.outputLimitExceeded ||
      request.signal?.aborted
    ) {
      throw new DocumentExtractionError(
        request.signal?.aborted
          ? "canceled"
          : result.termination === "timeout"
            ? "timeout"
            : result.signal || result.outputLimitExceeded
              ? "resourceLimit"
              : "unavailable",
      );
    }
    const output: unknown = JSON.parse(result.stdout);
    if (output && typeof output === "object" && "error" in output) {
      switch (output.error) {
        case "encrypted":
        case "malformed":
        case "missingPart":
        case "unsupported":
        case "resourceLimit":
        case "io":
          throw new DocumentExtractionError(output.error);
      }
    }
    if (
      !output ||
      typeof output !== "object" ||
      !("text" in output) ||
      typeof output.text !== "string" ||
      output.text.length > maxChars
    ) {
      throw new DocumentExtractionError("io");
    }
    return { text: output.text, images: [] };
  } catch (error) {
    // Never expose child stderr, native errors, binding paths, or file content.
    throw error instanceof DocumentExtractionError
      ? error
      : new DocumentExtractionError("unavailable");
  } finally {
    conversionActive = false;
  }
}

export function createOfficeDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "office",
    label: "Office and OpenDocument",
    mimeTypes: Object.keys(OFFICE_DOCUMENT_FORMATS),
    autoDetectOrder: 20,
    extract: extractOfficeContent,
  };
}
