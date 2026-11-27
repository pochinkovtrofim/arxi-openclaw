import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

function tool(name: string): AnyAgentTool & { execute: ReturnType<typeof vi.fn> } {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} } as never,
    execute: vi.fn(async () => ({ content: [{ type: "text", text: `${name} ran` }], details: {} })),
  };
}

// An Automation capped to message and ro_life lists its owner's whole surface.
const listed = ["message", "browser", "ro_life", "sessions_spawn"].map(tool);
const callable = listed.filter((entry) => ["message", "ro_life"].includes(entry.name));

function request(message: Parameters<typeof handleMcpJsonRpc>[0]["message"]) {
  return handleMcpJsonRpc({
    message,
    tools: callable,
    toolSchema: buildMcpToolSchema(callable),
    listedToolSchema: buildMcpToolSchema(listed),
    deferredTools: ["sessions_spawn"],
  });
}

describe("Gateway MCP loopback listed surface", () => {
  it("lists the uncapped surface exactly as an uncapped run lists it", async () => {
    const capped = (await request({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: unknown[] };
    };
    const uncapped = (await handleMcpJsonRpc({
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      tools: listed,
      toolSchema: buildMcpToolSchema(listed),
      deferredTools: ["sessions_spawn"],
    })) as { result: { tools: unknown[] } };

    expect(capped.result.tools).toEqual(uncapped.result.tools);
  });

  it("refuses a listed tool outside the cap without running it", async () => {
    const browser = listed.find((entry) => entry.name === "browser")!;
    const response = (await request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser", arguments: {} },
    })) as { result: { content: Array<{ text?: string }>; isError: boolean } };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toBe(
      "browser is not allowed in this Automation: it may call only the tools it was created with. Continue with those.",
    );
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it("runs a tool inside the cap", async () => {
    const response = (await request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ro_life", arguments: {} },
    })) as { result: { content: Array<{ text?: string }>; isError: boolean } };

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toBe("ro_life ran");
  });

  it("keeps the plain refusal for a tool that is not listed at all", async () => {
    const response = (await request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "exec", arguments: {} },
    })) as { result: { content: Array<{ text?: string }>; isError: boolean } };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toBe("Tool not available: exec");
  });
});
