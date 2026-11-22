import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";

/**
 * The text written before a run's first tool call reaches the Owner as a
 * message of its own (the CLI and embedded runners' emitPreToolText). Reply
 * directives, media lines and a silent reply are control for the reply path,
 * not words for her, so they never reach that message. Nothing left to say
 * means no message.
 */
export function ownerPreambleText(raw: string): string | undefined {
  const parsed = parseReplyDirectives(raw);
  if (parsed.isSilent || (parsed.mediaUrls?.length ?? 0) > 0) {
    return undefined;
  }
  return parsed.text.trim() || undefined;
}
