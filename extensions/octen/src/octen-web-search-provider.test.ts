import { describe, expect, it, vi } from "vitest";
import { createOctenWebSearchProvider } from "./octen-web-search-provider.js";

function tool() {
  const created = createOctenWebSearchProvider().createTool({
    config: {
      plugins: { entries: { octen: { config: { webSearch: { apiKey: "octen-test-key" } } } } },
    },
    searchConfig: { cacheTtlMinutes: 0 },
  } as never);
  if (!created) {
    throw new Error("Octen tool was unavailable");
  }
  return created;
}

describe("octen web search provider", () => {
  it("maps publication filters and highlighted results without requesting full content", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            results: [
              {
                title: "Official docs",
                url: "https://example.org/docs",
                highlight: "Relevant passage",
                time_published: "2026-09-20T10:00:00Z",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const result = await tool().execute({
        query: "official docs",
        count: 3,
        date_after: "2026-09-01",
      });
      expect(result).toMatchObject({ provider: "octen", count: 1 });
      expect(JSON.stringify(result)).toContain("Relevant passage");
      const init = fetchMock.mock.calls[0]?.[1];
      expect(JSON.parse(String(init?.body))).toEqual({
        query: "official docs",
        count: 3,
        time_basis: "published",
        start_time: "2026-09-01T00:00:00Z",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("treats a nonzero Octen code as a failed search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: 403, msg: "insufficient balance", data: { results: [] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    try {
      await expect(tool().execute({ query: "failed octen search" })).rejects.toThrow(
        "Octen rejected",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
