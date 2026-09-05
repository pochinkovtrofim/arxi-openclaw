const DOCUMENT_FAILURE_MESSAGES = {
  encrypted: "Document is encrypted or password-protected; local extraction cannot read it.",
  malformed: "Document is damaged or incomplete; no reliable text could be extracted.",
  missingPart: "Document is missing a required part; no reliable text could be extracted.",
  unsupported: "Document bytes do not identify a supported local document format.",
  resourceLimit: "Document exceeds local parser safety limits.",
  io: "Document could not be read locally.",
  canceled: "Document extraction was canceled.",
  timeout: "Document extraction exceeded its time limit.",
  unavailable: "Local document extraction is unavailable in this runtime.",
} as const;

export type DocumentExtractionFailure = keyof typeof DOCUMENT_FAILURE_MESSAGES;

export function documentExtractionFailureMessage(code: DocumentExtractionFailure): string {
  return DOCUMENT_FAILURE_MESSAGES[code];
}

/** Content-free failures safe to render; never constructed from parser messages. */
export class DocumentExtractionError extends Error {
  constructor(readonly code: DocumentExtractionFailure) {
    super(documentExtractionFailureMessage(code));
    this.name = "DocumentExtractionError";
  }
}

/** Image extracted from a document page. */
export type DocumentExtractedImage = {
  type: "image";
  data: string;
  mimeType: string;
};

/** Request passed to plugin document extractors. */
export type DocumentExtractionRequest = {
  buffer: Buffer;
  mimeType: string;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  /** Owning input pipeline's output ceiling and conversion deadline. */
  maxChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  password?: string;
  pageNumbers?: number[];
  onImageExtractionError?: (error: unknown) => void;
};

/** Text and image result returned by a document extractor. */
export type DocumentExtractionResult = {
  text: string;
  images: DocumentExtractedImage[];
};

/** Plugin document extractor capability contract. */
export type DocumentExtractorPlugin = {
  id: string;
  label: string;
  mimeTypes: readonly string[];
  autoDetectOrder?: number;
  extract: (request: DocumentExtractionRequest) => Promise<DocumentExtractionResult | null>;
};

/** Registered document extractor with owning plugin id. */
export type PluginDocumentExtractorEntry = DocumentExtractorPlugin & {
  pluginId: string;
};
