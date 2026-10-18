import { describe, expect, it } from "vitest";
import { consumeMcpCodeModeGuestResult, projectMcpCallToolResult } from "./mcp-content.js";

function nestedStructuredContent(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

describe("projectMcpCallToolResult", () => {
  it.each([
    { label: "pretty", text: JSON.stringify({ zeta: 2, alpha: "<a>&" }, null, 2) },
    { label: "compact", text: '{"zeta":2,"alpha":"<a>&"}' },
    { label: "reordered and escaped", text: ' {"alpha":"\\u003ca\\u003e\\u0026","zeta":2}\n' },
  ])("deduplicates the $label mirror only for the model", ({ text }) => {
    const structuredContent = { zeta: 2, alpha: "<a>&" };
    const content = [{ type: "text", text }];
    const result = projectMcpCallToolResult({ content, structuredContent });
    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{\n  "alpha": "<a>&",\n  "zeta": 2\n}' },
    ]);
    expect(result.details).toEqual({ structuredContent });
    expect(consumeMcpCodeModeGuestResult(result)).toEqual({ content, structuredContent });
  });

  it("preserves recovery text, partial or different JSON, and other content in order", () => {
    const content = [
      { type: "text", text: 'Retry after login: {"items":[1,2],"retryable":true}' },
      { type: "text", text: '{"retryable":true}' },
      { type: "text", text: '{"items":[2,1],"retryable":true}' },
      { type: "text", text: '{"items":[1,2],"retryable":true,"extra":null}' },
      { type: "text", text: '{"items":' },
      { type: "text", text: "[".repeat(20_000) + "0" + "]".repeat(20_000) },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ];
    const structuredContent = { items: [1, 2], retryable: true };
    const result = projectMcpCallToolResult({ content, structuredContent, isError: true });
    expect(result.content.slice(1)).toEqual(content);
    expect(result.details).toEqual({ structuredContent, status: "error" });
    expect(consumeMcpCodeModeGuestResult(result)).toEqual({
      content,
      structuredContent,
      isError: true,
    });
  });

  it.each([
    { label: "ordinary", deep: false, isError: undefined },
    { label: "server error", deep: false, isError: true },
    { label: "unprojectable", deep: true, isError: false },
  ])("projects $label structured content for model and guest callers", ({ deep, isError }) => {
    const result = projectMcpCallToolResult({
      content: deep ? [{ type: "text", text: "recovery guidance" }] : [],
      structuredContent: deep ? nestedStructuredContent(100_000) : { answer: 42 },
      isError,
    });
    if (deep) {
      const content = [
        {
          type: "text",
          text: "structuredContent was too deeply nested to project. Ask the MCP server for a flatter result or query a specific field.",
        },
        { type: "text", text: "recovery guidance" },
      ];
      expect(result.content).toEqual(content);
      expect(result.details).toEqual({ status: "error" });
      // Recursive downstream digests must not receive the unprojectable value.
      expect(result.details).not.toHaveProperty("structuredContent");
      expect(consumeMcpCodeModeGuestResult(result)).toEqual({ content, isError: true });
    } else {
      expect(result.content).toEqual([
        { type: "text", text: 'structuredContent:\n{\n  "answer": 42\n}' },
      ]);
      expect(result.details).toEqual({
        structuredContent: { answer: 42 },
        ...(isError ? { status: "error" } : {}),
      });
    }
  });
});
