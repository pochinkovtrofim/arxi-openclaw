import { describe, expect, it } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
} from "../../test/helpers/image-fixtures.js";
import { LOOPBACK_TOOL_IMAGE_MAX_BYTES } from "../agents/image-sanitization.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

type Block = { type: string; text?: string; data?: string; mimeType?: string };

async function callScreenshotTool(png: Buffer) {
  const tool: AnyAgentTool = {
    name: "screen",
    label: "Screen",
    description: "Take a screenshot",
    parameters: { type: "object", properties: {} } as never,
    execute: async () => ({
      content: [
        { type: "text", text: '{"device":"mac"}' },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
      details: {},
    }),
  };
  const response = (await handleMcpJsonRpc({
    message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screen" } },
    tools: [tool],
    toolSchema: buildMcpToolSchema([tool]),
  })) as { result: { content: Block[]; isError: boolean } };
  return response.result;
}

describe("Gateway MCP loopback tool images", () => {
  it("re-encodes an image over the loopback budget before the client keeps it", async () => {
    const png = createNoisyPngBuffer(900, 560);
    expect(png.byteLength).toBeGreaterThan(LOOPBACK_TOOL_IMAGE_MAX_BYTES);

    const result = await callScreenshotTool(png);

    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: '{"device":"mac"}' });
    const image = result.content[1];
    expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(Buffer.from(image?.data ?? "", "base64").byteLength).toBeLessThanOrEqual(
      LOOPBACK_TOOL_IMAGE_MAX_BYTES,
    );
  });

  it("passes an image within the budget through unchanged", async () => {
    const png = createSolidPngBuffer(640, 400, { r: 20, g: 40, b: 60 });

    const result = await callScreenshotTool(png);

    expect(result.content[1]).toEqual({
      type: "image",
      data: png.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("sends an image it cannot re-encode as it came, not as an omission note", async () => {
    const notAnImage = Buffer.alloc(LOOPBACK_TOOL_IMAGE_MAX_BYTES + 1, 7);

    const result = await callScreenshotTool(notAnImage);

    expect(result.content[1]).toEqual({
      type: "image",
      data: notAnImage.toString("base64"),
      mimeType: "image/png",
    });
  });
});
