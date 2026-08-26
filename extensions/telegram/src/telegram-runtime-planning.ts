import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  classifyAttachmentBytes,
  extensionForMime,
  type MediaKind,
} from "openclaw/plugin-sdk/media-mime";
import { getImageMetadata, isGifMedia, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveTelegramPlainCaption, splitTelegramCaption } from "./caption.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";

const MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 10_000;
const MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20;

type TelegramCaptionPlan = {
  caption?: string;
  htmlCaption?: string;
  plainCaption?: string;
  followUpText?: string;
};

export function planTelegramCaption(params: {
  text?: string;
  textMode?: "markdown" | "html";
  tableMode?: MarkdownTableMode;
  preparedHtml?: boolean;
}): TelegramCaptionPlan {
  const trimmedText = params.text?.trim();
  if (!trimmedText) {
    return {};
  }
  const renderedCaption =
    params.preparedHtml === true && params.textMode === "html"
      ? trimmedText
      : renderTelegramHtmlText(trimmedText, {
          textMode: params.textMode,
          tableMode: params.tableMode,
        });
  const { caption, followUpText } = splitTelegramCaption(params.text, renderedCaption);
  if (!caption) {
    return followUpText ? { followUpText } : {};
  }
  const htmlCaption = renderedCaption;
  const plainSource =
    params.textMode === "html" ? telegramHtmlToPlainTextFallback(caption) : caption;
  return {
    caption,
    htmlCaption,
    plainCaption: resolveTelegramPlainCaption(plainSource, htmlCaption),
  };
}

export function resolveTelegramOutboundMediaFilename(params: {
  fileName?: string;
  contentType?: string;
  kind?: MediaKind;
  isGif: boolean;
}): string {
  if (params.fileName) {
    return params.fileName;
  }
  if (params.isGif) {
    return "animation.gif";
  }

  const basename =
    params.kind === "image" || params.kind === "video" || params.kind === "audio"
      ? params.kind
      : "file";
  const defaultExtension =
    params.kind === "image"
      ? ".jpg"
      : params.kind === "video"
        ? ".mp4"
        : params.kind === "audio"
          ? ".ogg"
          : ".bin";
  return `${basename}${extensionForMime(params.contentType) ?? defaultExtension}`;
}

export async function shouldSendTelegramImageAsPhoto(
  buffer: Buffer,
  warn: (message: string) => void = () => {},
  readMetadata: typeof getImageMetadata = getImageMetadata,
): Promise<boolean> {
  try {
    const metadata = await readMetadata(buffer);
    const width = metadata?.width;
    const height = metadata?.height;
    if (typeof width !== "number" || typeof height !== "number") {
      warn("Photo dimensions are unavailable. Sending as document instead.");
      return false;
    }

    const shorterSide = Math.min(width, height);
    const longerSide = Math.max(width, height);
    const isValidPhoto =
      width + height <= MAX_TELEGRAM_PHOTO_DIMENSION_SUM &&
      shorterSide > 0 &&
      longerSide <= shorterSide * MAX_TELEGRAM_PHOTO_ASPECT_RATIO;
    if (!isValidPhoto) {
      warn(
        `Photo dimensions (${width}x${height}) are not valid for Telegram photos. Sending as document instead.`,
      );
    }
    return isValidPhoto;
  } catch (error) {
    warn(
      `Failed to validate photo dimensions: ${formatErrorMessage(error)}. Sending as document instead.`,
    );
    return false;
  }
}

export type TelegramPhotoDocumentDeliveryPlan = {
  kind: "photo" | "document";
  photoFallbackKind?: "document";
  fileName: string;
  mediaType: string;
  caption?: string;
  fallbackCaption?: string;
  followUpText?: string;
};

export async function planTelegramPhotoDocumentDelivery(params: {
  bytes: Buffer;
  fileName?: string;
  declaredMime?: string | null;
  text?: string;
  textMode?: "markdown" | "html";
  forceDocument?: boolean;
}): Promise<TelegramPhotoDocumentDeliveryPlan> {
  const classification = await classifyAttachmentBytes({
    buffer: params.bytes,
    declaredMime: params.declaredMime,
    name: params.fileName,
  });
  const mediaType = classification.mime ?? "application/octet-stream";
  const mediaKind = kindFromMime(mediaType);
  const isGif = isGifMedia({ contentType: mediaType, fileName: params.fileName });
  const isPhoto =
    params.forceDocument !== true &&
    mediaKind === "image" &&
    !isGif &&
    (await shouldSendTelegramImageAsPhoto(params.bytes));
  const caption = planTelegramCaption({ text: params.text, textMode: params.textMode });
  return {
    kind: isPhoto ? "photo" : "document",
    ...(isPhoto ? { photoFallbackKind: "document" as const } : {}),
    fileName: resolveTelegramOutboundMediaFilename({
      fileName: params.fileName,
      contentType: mediaType,
      kind: mediaKind,
      isGif,
    }),
    mediaType,
    ...(caption.htmlCaption ? { caption: caption.htmlCaption } : {}),
    ...(caption.plainCaption ? { fallbackCaption: caption.plainCaption } : {}),
    ...(caption.followUpText ? { followUpText: caption.followUpText } : {}),
  };
}
