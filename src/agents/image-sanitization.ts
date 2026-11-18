/**
 * Resolves image sanitization limits for historical session messages.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Image sanitization limits shared by tools and provider payload builders.
export type ImageSanitizationLimits = {
  maxDimensionPx?: number;
  maxBytes?: number;
};

export const DEFAULT_IMAGE_MAX_DIMENSION_PX = 1200;
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// A CLI harness (Claude Code) keeps every tool image in its own history and sends
// it again on each later request. Once the request's base64 media passes the
// harness's cap (20 MiB or more in Claude Code 2.1.311), it drops the oldest images,
// which changes the early history and rewrites the whole prompt cache after the
// first one. Screenshots re-encoded to JPEG at full 1200 px fit this budget and
// stay legible; PNG screenshots of the same screen were about three times larger.
export const LOOPBACK_TOOL_IMAGE_MAX_BYTES = 160 * 1024;

/** Resolve configured image sanitization limits for agent payloads. */
export function resolveImageSanitizationLimits(cfg?: OpenClawConfig): ImageSanitizationLimits {
  const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return {};
  }
  return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}
