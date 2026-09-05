/**
 * Public SDK type surface for document extractor plugins.
 */
export { OFFICE_DOCUMENT_FORMATS, officeDocumentFormat } from "@openclaw/media-core/mime";
export { DocumentExtractionError } from "../plugins/document-extractor-types.js";
export type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "../plugins/document-extractor-types.js";
