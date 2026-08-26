import { formatMediaPlaceholderText } from "openclaw/plugin-sdk/channel-inbound";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import type { TelegramMediaKind } from "./bot/body-helpers.js";
import { resolveTelegramPromptMediaPath } from "./prompt-media-path.js";

type TelegramContextSenderEvidence = {
  displayName?: string;
  stableId?: string;
  username?: string;
};

type TelegramContextRenderEntry = {
  messageId?: string;
  sender?: string;
  senderId?: string;
  senderUsername?: string;
  replyToId?: string;
  timestamp?: number;
  body?: string;
  isQuote?: boolean;
  selectedQuote?: string;
  surroundingBody?: string;
  mediaKind?: TelegramMediaKind;
  mediaType?: string;
  mediaPath?: string;
  mediaRef?: string;
  forwardedFrom?: string;
  forwardedFromId?: string;
  forwardedFromUsername?: string;
  forwardedDate?: number;
};

type TelegramSenderEvidenceStrength =
  | "stable-id"
  | "username"
  | "display-name-only"
  | "unavailable";

function senderEvidenceStrength(
  evidence: TelegramContextSenderEvidence,
): TelegramSenderEvidenceStrength {
  if (evidence.stableId) {
    return "stable-id";
  }
  if (evidence.username) {
    return "username";
  }
  if (evidence.displayName) {
    return "display-name-only";
  }
  return "unavailable";
}

function formatSenderEvidence(evidence: TelegramContextSenderEvidence): string {
  const details = [
    evidence.stableId ? `sender_id:${evidence.stableId}` : undefined,
    evidence.username ? `sender_username:@${evidence.username}` : undefined,
    `sender_evidence:${senderEvidenceStrength(evidence)}`,
  ].filter(Boolean);
  return details.join(" ");
}

/** Canonical Telegram forward annotation used by both native and external ingress. */
export function formatTelegramForwardedMessageBody(params: {
  body: string;
  forwardedFrom?: string;
  forwardedDate?: number;
}): string {
  const forwardedAt = timestampMsToIsoString(params.forwardedDate);
  const forwardPrefix = params.forwardedFrom
    ? `[Forwarded from ${params.forwardedFrom}${forwardedAt ? ` at ${forwardedAt}` : ""}]`
    : undefined;
  return [forwardPrefix, params.body].filter(Boolean).join("\n");
}

export function isTelegramContextMediaKind(value: string): value is TelegramMediaKind {
  switch (value) {
    case "audio":
    case "document":
    case "image":
    case "sticker":
    case "video":
      return true;
    default:
      return false;
  }
}

/** Canonical Telegram reply-chain projection used by every Telegram ingress boundary. */
function formatTelegramReplyContextEntry(entry: TelegramContextRenderEntry, index: number): string {
  const mediaPath = entry.mediaPath ? resolveTelegramPromptMediaPath(entry.mediaPath) : undefined;
  const sender = entry.sender ?? "unknown sender";
  const labels = [
    `${index + 1}. ${sender}`,
    entry.messageId ? `id:${entry.messageId}` : undefined,
    entry.replyToId ? `reply_to:${entry.replyToId}` : undefined,
    entry.timestamp ? timestampMsToIsoString(entry.timestamp) : undefined,
  ].filter(Boolean);
  const selectedQuote = entry.selectedQuote ?? (entry.isQuote ? entry.body : undefined);
  const surroundingBody = entry.surroundingBody ?? (entry.isQuote ? undefined : entry.body);
  const body = [
    selectedQuote ? `[Selected quote]\n"${selectedQuote}"` : undefined,
    surroundingBody ? `[Surrounding reply body]\n${surroundingBody}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const mediaInput = (() => {
    if (entry.mediaKind) {
      return { kind: entry.mediaKind };
    }
    const mediaType = entry.mediaType;
    return mediaType && isTelegramContextMediaKind(mediaType)
      ? { kind: mediaType }
      : { contentType: mediaType };
  })();
  const bodyLines = [
    `[Sender evidence ${formatSenderEvidence({
      displayName: entry.sender,
      stableId: entry.senderId,
      username: entry.senderUsername,
    })}]`,
    formatTelegramForwardedMessageBody({
      body,
      forwardedFrom: entry.forwardedFrom,
      forwardedDate: entry.forwardedDate,
    }),
    entry.mediaKind || entry.mediaType ? formatMediaPlaceholderText([mediaInput]) : undefined,
    mediaPath ? `[media_path:${mediaPath}]` : undefined,
    entry.mediaRef ? `[media_ref:${entry.mediaRef}]` : undefined,
  ].filter(Boolean);
  return `[${labels.join(" ")}]\n${bodyLines.join("\n")}`;
}

/** Renders one canonical nearest-first Telegram reply context block. */
export function formatTelegramReplyContext(entries: readonly TelegramContextRenderEntry[]): string {
  return `[Reply chain - nearest first]\n${entries
    .map(formatTelegramReplyContextEntry)
    .join("\n")}\n[/Reply chain]`;
}
