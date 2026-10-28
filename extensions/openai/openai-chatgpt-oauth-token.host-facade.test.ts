import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshOpenAIAccessToken } from "./openai-chatgpt-oauth-token.runtime.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAI token refresh at the Arxi host facade", () => {
  it("refreshes directly at the loopback facade the guest names", async () => {
    const requests: Array<{ url?: string; type?: string; body: string }> = [];
    const facade = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        requests.push({ url: request.url, type: request.headers["content-type"], body });
        response.setHeader("Content-Type", "application/json");
        response.end(
          '{"access_token":"new-access","refresh_token":"arxi-host-login-v1","expires_in":3600}',
        );
      });
    });
    facade.listen(0, "127.0.0.1");
    await once(facade, "listening");
    const address = facade.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP facade address");
    }
    // The guest's setup: everything but loopback goes through the egress proxy.
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("https_proxy", "http://127.0.0.1:9");
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
    vi.stubEnv("no_proxy", "127.0.0.1,localhost");
    vi.stubEnv(
      "ARXI_OPENAI_OAUTH_TOKEN_URL",
      `http://127.0.0.1:${address.port}/openai/oauth/token`,
    );
    try {
      const result = await refreshOpenAIAccessToken("arxi-host-login-v1");

      expect(result).toMatchObject({
        type: "success",
        access: "new-access",
        refresh: "arxi-host-login-v1",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/openai/oauth/token");
      expect(requests[0]?.type).toBe("application/x-www-form-urlencoded");
      expect(new URLSearchParams(requests[0]?.body).get("refresh_token")).toBe(
        "arxi-host-login-v1",
      );
    } finally {
      facade.close();
    }
  });
});
