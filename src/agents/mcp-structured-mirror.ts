import { stableStringify } from "@openclaw/normalization-core";

/**
 * Builds a predicate for text blocks that only mirror an MCP result's structuredContent.
 * Servers serialize that mirror differently (pretty, compact, other key order), so a block
 * counts as the mirror when it is complete JSON for the same value. Any other text, including
 * JSON for a different value, is kept because it can carry recovery guidance.
 */
export function createMcpStructuredContentMirrorMatcher(
  structuredContent: Record<string, unknown>,
): (text: string) => boolean {
  let pretty: string | undefined;
  let canonical: string | undefined;
  return (text) => {
    if (text === (pretty ??= JSON.stringify(structuredContent, null, 2))) {
      return true;
    }
    if (!text.trimStart().startsWith("{")) {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(
        text,
        (_key, value: unknown, context?: { source?: string }) => {
          // Parsing can round a precise numeric ID or decimal. Only
          // discard text whose number spelling survives unchanged.
          if (typeof value === "number" && context?.source !== JSON.stringify(value)) {
            throw new Error("MCP text contains a non-canonical JSON number");
          }
          return value;
        },
      );
      return stableStringify(parsed) === (canonical ??= stableStringify(structuredContent));
    } catch {
      // Not JSON, a non-canonical number, or too deeply nested to compare: keep the block.
      return false;
    }
  };
}
