import { createServer } from "node:http";
// Exa tests cover exa web search provider plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { testing } from "../test-api.js";
import { createExaWebSearchProvider as createContractExaWebSearchProvider } from "../web-search-contract-api.js";
import { createExaWebSearchProvider } from "./exa-web-search-provider.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function streamingJsonResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
} {
  // Streaming fixture proves an oversized success body stops being read before
  // the whole payload is buffered into memory.
  let reads = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("a".repeat(params.chunkSize)));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    getReadCount: () => reads,
  };
}

describe("exa web search provider", () => {
  it("does not send or cache an already canceled search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const tool = createExaWebSearchProvider().createTool({
      config: {
        plugins: { entries: { exa: { config: { webSearch: { apiKey: "exa-test-key" } } } } },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();
    controller.abort(new Error("Exa caller canceled"));

    try {
      await expect(
        tool.execute({ query: "exa pre-canceled" }, { signal: controller.signal }),
      ).rejects.toThrow("Exa caller canceled");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("aborts the guarded Exa request without losing the caller's reason", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            reject(new Error("Exa request lost caller cancellation"));
            return;
          }
          init.signal.addEventListener("abort", () => reject(init.signal?.reason as Error), {
            once: true,
          });
        }),
    );
    const tool = createExaWebSearchProvider().createTool({
      config: {
        plugins: { entries: { exa: { config: { webSearch: { apiKey: "exa-test-key" } } } } },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();
    const result = tool.execute(
      { query: "exa in-flight cancellation" },
      { signal: controller.signal },
    );

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new Error("Exa request canceled in flight"));
      await expect(result).rejects.toThrow("Exa request canceled in flight");
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createExaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("exa");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(provider.credentialPath).toBe("plugins.entries.exa.config.webSearch.apiKey");
    const pluginEntry = applied.plugins?.entries?.exa;
    if (!pluginEntry) {
      throw new Error("expected Exa plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createExaWebSearchProvider();
    const contractProvider = createContractExaWebSearchProvider();
    if (!contractProvider.applySelectionConfig) {
      throw new Error("Expected contract applySelectionConfig to be defined");
    }
    const applied = contractProvider.applySelectionConfig({});

    expect({
      id: contractProvider.id,
      label: contractProvider.label,
      hint: contractProvider.hint,
      onboardingScopes: contractProvider.onboardingScopes,
      credentialLabel: contractProvider.credentialLabel,
      envVars: contractProvider.envVars,
      placeholder: contractProvider.placeholder,
      signupUrl: contractProvider.signupUrl,
      docsUrl: contractProvider.docsUrl,
      autoDetectOrder: contractProvider.autoDetectOrder,
      credentialPath: contractProvider.credentialPath,
    }).toEqual({
      id: provider.id,
      label: provider.label,
      hint: provider.hint,
      onboardingScopes: provider.onboardingScopes,
      credentialLabel: provider.credentialLabel,
      envVars: provider.envVars,
      placeholder: provider.placeholder,
      signupUrl: provider.signupUrl,
      docsUrl: provider.docsUrl,
      autoDetectOrder: provider.autoDetectOrder,
      credentialPath: provider.credentialPath,
    });
    expect(contractProvider.createTool({ config: {}, searchConfig: {} })).toBeNull();
    const pluginEntry = applied.plugins?.entries?.exa;
    if (!pluginEntry) {
      throw new Error("expected contract Exa plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(testing.resolveExaApiKey({ apiKey: "exa-secret" })).toBe("exa-secret");
  });

  it("resolves Exa search base URL overrides", () => {
    expect(testing.resolveExaSearchEndpoint()).toEqual({
      endpoint: "https://api.exa.ai/search",
      mode: "strict",
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "https://proxy.example/exa" })).toEqual({
      endpoint: "https://proxy.example/exa/search",
      mode: "strict",
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "proxy.example/exa/search/" })).toEqual({
      endpoint: "https://proxy.example/exa/search",
      mode: "strict",
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "ftp://proxy.example/exa" })).toEqual({
      docs: "https://docs.openclaw.ai/tools/exa-search",
      error: "invalid_base_url",
      message:
        "plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/exa",
    });
  });

  it("uses only an explicit literal loopback origin for local Exa brokers", async () => {
    let receivedPath = "";
    let receivedBody = "";
    const local = createServer((request, response) => {
      receivedPath = request.url ?? "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end('{"results":[]}');
      });
    });
    await new Promise<void>((resolve, reject) => {
      local.once("error", reject);
      local.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = local.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP test listener");
      }
      const tool = createExaWebSearchProvider().createTool({
        config: {
          plugins: {
            entries: {
              exa: {
                config: {
                  webSearch: {
                    apiKey: "local-broker-marker",
                    localBaseUrl: `http://127.0.0.1:${address.port}`,
                    maxResults: 10,
                  },
                },
              },
            },
          },
        },
        searchConfig: {},
      });
      if (!tool) {
        throw new Error("Expected Exa tool");
      }
      await expect(
        tool.execute({
          query: "current result",
          count: 10,
          type: "deep-reasoning",
          date_after: "2026-08-01",
          date_before: "2026-08-25",
          contents: {
            text: { maxCharacters: 20_000 },
            highlights: {
              maxCharacters: 4_000,
              query: "current evidence",
              numSentences: 10,
              highlightsPerUrl: 10,
            },
            summary: { query: "short finding" },
          },
        }),
      ).resolves.toMatchObject({ provider: "exa" });
      expect(receivedPath).toBe("/search");
      expect(JSON.parse(receivedBody)).toEqual({
        query: "current result",
        numResults: 10,
        type: "deep-reasoning",
        contents: {
          text: { maxCharacters: 20_000 },
          highlights: {
            maxCharacters: 4_000,
            query: "current evidence",
            numSentences: 10,
            highlightsPerUrl: 10,
          },
          summary: { query: "short finding" },
        },
        startPublishedDate: "2026-08-01",
        endPublishedDate: "2026-08-25",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        local.close((error) => (error ? reject(error) : resolve())),
      );
    }

    for (const localBaseUrl of [
      "http://localhost:18081",
      "http://10.0.0.1:18081",
      "https://127.0.0.1:18081",
      "http://127.0.0.1",
    ]) {
      expect(testing.resolveExaSearchEndpoint({ localBaseUrl })).toMatchObject({
        error: "invalid_base_url",
      });
    }
  });

  it("does not follow even same-origin local broker redirects", async () => {
    let movedRequests = 0;
    const local = createServer((request, response) => {
      if (request.url === "/moved") {
        movedRequests += 1;
        response.setHeader("content-type", "application/json");
        response.end('{"results":[]}');
        return;
      }
      response.statusCode = 302;
      response.setHeader("location", "/moved");
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      local.once("error", reject);
      local.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = local.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP test listener");
      }
      const tool = createExaWebSearchProvider().createTool({
        config: {
          plugins: {
            entries: {
              exa: {
                config: {
                  webSearch: {
                    apiKey: "local-broker-marker",
                    localBaseUrl: `http://127.0.0.1:${address.port}`,
                  },
                },
              },
            },
          },
        },
        searchConfig: {},
      });
      if (!tool) {
        throw new Error("Expected Exa tool");
      }
      await expect(tool.execute({ query: "redirect attempt" })).rejects.toThrow(/redirect/i);
      expect(movedRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        local.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("partitions Exa cache keys by resolved endpoint", () => {
    const base = {
      type: "auto" as const,
      query: "openclaw",
      count: 5,
    };
    expect(
      testing.buildExaCacheKey({
        ...base,
        endpoint: "https://api.exa.ai/search",
      }),
    ).not.toBe(
      testing.buildExaCacheKey({
        ...base,
        endpoint: "https://proxy.example/exa/search",
      }),
    );
  });

  it("partitions Exa cache keys by effective content options", () => {
    const base = {
      endpoint: "https://api.exa.ai/search",
      type: "auto" as const,
      query: "openclaw",
      count: 5,
    };
    const defaultKey = testing.buildExaCacheKey(base);

    expect(testing.buildExaCacheKey({ ...base, contents: { highlights: true } })).toBe(defaultKey);

    const disabledKeys = [
      testing.buildExaCacheKey({ ...base, contents: { highlights: false } }),
      testing.buildExaCacheKey({ ...base, contents: { text: false } }),
      testing.buildExaCacheKey({ ...base, contents: { summary: false } }),
    ];
    expect(disabledKeys).not.toContain(defaultKey);
    expect(new Set(disabledKeys).size).toBe(disabledKeys.length);
  });

  it("normalizes Exa result descriptions from highlights before text", () => {
    expect(
      testing.resolveExaDescription({
        highlights: ["first", "", "second"],
        text: "full text",
      }),
    ).toBe("first\nsecond");
    expect(testing.resolveExaDescription({ text: "full text" })).toBe("full text");
  });

  it("handles month freshness without date overflow", () => {
    const iso = testing.resolveFreshnessStartDate("month");
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });

  it("accepts current Exa contents object options from the docs", () => {
    expect(
      testing.parseExaContents({
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      }),
    ).toEqual({
      value: {
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      },
    });
  });

  it("rejects invalid Exa contents objects", () => {
    expect(
      testing.parseExaContents({
        highlights: { numSentences: 0 },
      }),
    ).toEqual({
      error: "invalid_contents",
      message: "contents.highlights.numSentences must be an integer from 1 to 10.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("aligns the advertised and enforced Exa result cap", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            exa: { config: { webSearch: { apiKey: "exa-secret", maxResults: 7 } } },
          },
        },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const parameters = tool.parameters as {
      properties?: {
        count?: { maximum?: number };
        type?: { enum?: string[] };
      };
    };

    expect(parameters.properties?.count?.maximum).toBe(7);
    expect(parameters.properties?.type?.enum).toEqual([
      "auto",
      "neural",
      "fast",
      "deep",
      "deep-reasoning",
      "instant",
    ]);
    expect(testing.resolveExaSearchCount(7, 5, 7)).toBe(7);
    expect(testing.resolveExaSearchCount(8, 5, 7)).toBe(7);
    expect(testing.resolveExaSearchCount("+05", 5, 7)).toBe(5);
    expect(testing.resolveExaSearchCount("0x10", 5, 7)).toBe(5);
    expect(testing.resolveExaSearchCount("1e2", 5, 7)).toBe(5);
    expect(testing.resolveExaSearchCount(1.5, 5, 7)).toBe(5);
    await expect(tool.execute({ query: "too many", count: 8 })).rejects.toThrow(
      "count must be an integer from 1 to 7",
    );
  });

  it("returns validation errors for conflicting time filters", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: { entries: { exa: { config: { webSearch: { apiKey: "exa-secret" } } } } },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      freshness: "day",
      date_after: "2026-03-01",
    });

    expect(result).toEqual({
      error: "conflicting_time_filters",
      message:
        "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("returns validation errors for invalid date input", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: { entries: { exa: { config: { webSearch: { apiKey: "exa-secret" } } } } },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-02-31",
    });

    expect(result).toEqual({
      error: "invalid_date",
      message: "date_after must be YYYY-MM-DD format.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("reports malformed Exa API JSON with a stable provider error", async () => {
    await expect(testing.readExaSearchResults(new Response("{ nope"))).rejects.toThrow(
      "Exa API returned malformed JSON",
    );
  });

  it("rejects invalid UTF-8 in Exa search JSON", async () => {
    const prefix = new TextEncoder().encode(
      '{"results":[{"url":"https://example.com","title":"bad',
    );
    const suffix = new TextEncoder().encode('"}]}');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix);
    body[prefix.length] = 0xff;
    body.set(suffix, prefix.length + 1);

    await expect(testing.readExaSearchResults(new Response(body))).rejects.toThrow(
      "Exa API returned malformed JSON",
    );
  });

  it("parses well-formed Exa search JSON under the byte cap", async () => {
    const response = new Response(
      JSON.stringify({ results: [{ url: "https://example.com", title: "Example" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    await expect(testing.readExaSearchResults(response)).resolves.toEqual([
      { url: "https://example.com", title: "Example" },
    ]);
  });

  it("caps oversized Exa search JSON instead of buffering the whole body", async () => {
    const streamed = streamingJsonResponse({ chunkCount: 64, chunkSize: 1024 });

    await expect(
      testing.readExaSearchResults(streamed.response, { maxBytes: 4096 }),
    ).rejects.toThrow(/Exa API response exceeds 4096 bytes/);

    expect(streamed.getReadCount()).toBeLessThan(64);
  });

  it("bounds Exa API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"exa upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));

    const detail = await testing.readExaErrorDetail(tracked.response);

    expect(detail).toContain("exa upstream unavailable");
    expect(detail).not.toContain("tail");
    expect(await testing.readExaErrorDetail(new Response("short"))).toBe("short");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
