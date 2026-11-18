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
// Byte target for tool images sent to a CLI harness over loopback MCP. The
// harness keeps them in its own history and drops the oldest once a request's
// media passes its cap, which rewrites the prompt cache (Ro: platform/docs/claude-code.md).
export const LOOPBACK_TOOL_IMAGE_MAX_BYTES = 160 * 1024;

/** Resolve configured image sanitization limits for agent payloads. */
export function resolveImageSanitizationLimits(cfg?: OpenClawConfig): ImageSanitizationLimits {
  const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return {};
  }
  return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}
