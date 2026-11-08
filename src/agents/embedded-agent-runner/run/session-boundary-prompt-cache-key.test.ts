import { describe, expect, it } from "vitest";
import { resolveSessionBoundaryPromptCacheKey } from "./session-boundary-prompt-cache-key.js";

describe("resolveSessionBoundaryPromptCacheKey", () => {
  it("is stable within a lifecycle window and changes across reset or compaction boundaries", () => {
    const resolve = (boundaryCount: number) =>
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-responses",
        boundaryCount,
        sessionId: "session-1",
      });

    expect([resolve(0), resolve(0), resolve(1), resolve(2)]).toEqual([
      "session-1:0",
      "session-1:0",
      "session-1:1",
      "session-1:2",
    ]);
  });

  it("preserves an explicit caller cache key", () => {
    expect(
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-responses",
        boundaryCount: 4,
        promptCacheKey: "caller-key",
        sessionId: "session-1",
      }),
    ).toBe("caller-key");
  });

  it("shares one ChatGPT subscription key across an agent's sessions and boundaries", () => {
    const resolve = (
      sessionId: string,
      boundaryCount: number,
      agentId = "main",
      modelId = "gpt-6.1",
    ) =>
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-chatgpt-responses",
        boundaryCount,
        sessionId,
        agentId,
        modelId,
      });

    const key = resolve("steward-run", 0);
    expect(key).toMatch(/^openclaw-agent-[0-9a-f]{32}$/);
    expect(resolve("free-will-run", 3)).toBe(key);
    expect(resolve("steward-run", 0, "other")).not.toBe(key);
    expect(resolve("steward-run", 0, "main", "gpt-6.1-mini")).not.toBe(key);
    expect(
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-chatgpt-responses",
        boundaryCount: 0,
        promptCacheKey: "caller-key",
        sessionId: "steward-run",
        agentId: "main",
      }),
    ).toBe("caller-key");
    expect(
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-responses",
        boundaryCount: 0,
        sessionId: "steward-run",
        agentId: "main",
      }),
    ).toBe("steward-run:0");
  });

  it("keeps long Unicode derived keys distinct across boundaries within the 64-char limit", () => {
    const longSessionId = `internal-session-effects-${"🦞".repeat(64)}`;
    const keys = [0, 1, 2].map((boundaryCount) =>
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-responses",
        boundaryCount,
        sessionId: longSessionId,
      }),
    );

    expect(new Set(keys).size).toBe(keys.length);
    for (const [boundaryCount, key] of keys.entries()) {
      expect(key).toBeDefined();
      expect(Array.from(key ?? "").length).toBeLessThanOrEqual(64);
      expect(key?.endsWith(`:${boundaryCount}`)).toBe(true);
    }
  });
});
