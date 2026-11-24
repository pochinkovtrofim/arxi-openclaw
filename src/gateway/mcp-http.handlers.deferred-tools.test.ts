import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} } as never,
    execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: {} }),
  };
}

const tools = ["browser", "sessions_spawn", "google_workspace__google_artifact_get"].map(tool);

async function list(deferredTools?: readonly string[]) {
  const response = (await handleMcpJsonRpc({
    message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    tools,
    toolSchema: buildMcpToolSchema(tools),
    ...(deferredTools ? { deferredTools } : {}),
  })) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } };
  return response.result.tools;
}

describe("Gateway MCP loopback deferred tools", () => {
  it("lists every tool unmarked when the operator defers none", async () => {
    const listed = await list();
    expect(listed.map((entry) => entry.name)).toEqual(tools.map((entry) => entry.name));
    expect(listed.some((entry) => entry._meta)).toBe(false);
  });

  it("marks exact names and prefixes for Claude Code's tool search and keeps the rest loaded", async () => {
    const listed = await list(["sessions_spawn", "google_workspace__google_artifact_*"]);
    expect(listed.map((entry) => [entry.name, entry._meta])).toEqual([
      ["browser", undefined],
      ["sessions_spawn", { "anthropic/alwaysLoad": false }],
      ["google_workspace__google_artifact_get", { "anthropic/alwaysLoad": false }],
    ]);
    expect(listed[1]).toMatchObject(buildMcpToolSchema([tools[1]])[0]);
  });

  it("still runs a deferred tool once Claude loads it", async () => {
    const response = (await handleMcpJsonRpc({
      message: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sessions_spawn" } },
      tools,
      toolSchema: buildMcpToolSchema(tools),
      deferredTools: ["sessions_spawn"],
    })) as { result: { content: Array<{ text?: string }>; isError: boolean } };
    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toBe("sessions_spawn ran");
  });
});
