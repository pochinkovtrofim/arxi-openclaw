import { describe, expect, it } from "vitest";
import { requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";

describe("requester MCP OAuth identity", () => {
  it("rejects requester OAuth identity without an authenticated sender", () => {
    expect(() =>
      requesterMcpOAuthIdentity("Shared", "https://mcp.example.com/shared", {
        messageChannel: "telegram",
        agentAccountId: "bot",
      }),
    ).toThrow("authenticated requester sender identity is required");
  });
});
