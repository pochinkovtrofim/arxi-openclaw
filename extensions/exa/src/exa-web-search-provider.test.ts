// Exa tests cover exa web search provider plugin behavior.
import { createServer } from "node:http";
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

  it("keeps the contract export aligned with provider metadata", () => {
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
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      expect(contractProvider.createTool({ config: {}, searchConfig: {} })).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
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
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "https://proxy.example/exa" })).toEqual({
      endpoint: "https://proxy.example/exa/search",
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "proxy.example/exa/search/" })).toEqual({
      endpoint: "https://proxy.example/exa/search",
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "ftp://proxy.example/exa" })).toEqual({
      docs: "https://docs.openclaw.ai/tools/exa-search",
      error: "invalid_base_url",
      message:
        "plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/exa",
    });
  });

  it("uses the exact Arxi loopback endpoint without changing normal Exa endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const previousProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    try {
      const tool = createExaWebSearchProvider().createTool({
        config: {
          plugins: {
            entries: {
              exa: {
                config: {
                  webSearch: {
                    apiKey: "arxi-host-exa-v1",
                    baseUrl: "http://127.0.0.1:18080",
                  },
                },
              },
            },
          },
        },
        searchConfig: {},
      });
      if (!tool) {
        throw new Error("Expected tool definition");
      }
      await tool.execute({ query: "recent result" });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:18080/search",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      fetchMock.mockRestore();
      if (previousProxy === undefined) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = previousProxy;
      }
    }
  });

  it.sequential("executes a real bounded loopback search with the marker credential", async () => {
    let requestBody = "";
    let marker = "";
    const server = createServer((request, response) => {
      marker = String(request.headers["x-api-key"] ?? "");
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            results: [
              {
                title: "Recent result",
                url: "https://example.test/recent",
                highlights: ["current fact"],
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(18080, "127.0.0.1", resolve);
    });
    try {
      const tool = createExaWebSearchProvider().createTool({
        config: {
          plugins: {
            entries: {
              exa: {
                config: {
                  webSearch: {
                    apiKey: "arxi-host-exa-v1",
                    baseUrl: "http://127.0.0.1:18080",
                  },
                },
              },
            },
          },
        },
        searchConfig: { cacheTtlMinutes: 0 },
      });
      if (!tool) {
        throw new Error("Expected tool definition");
      }
      const result = await tool.execute({ query: "latest fact", count: 3 });
      expect(marker).toBe("arxi-host-exa-v1");
      expect(JSON.parse(requestBody)).toMatchObject({ query: "latest fact", numResults: 3 });
      expect(result).toMatchObject({
        results: [expect.objectContaining({ url: "https://example.test/recent" })],
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("does not widen the Arxi loopback seam to another port", async () => {
    const tool = createExaWebSearchProvider().createTool({
      config: {
        plugins: {
          entries: {
            exa: {
              config: {
                webSearch: {
                  apiKey: "arxi-host-exa-v1",
                  baseUrl: "http://127.0.0.1:18081",
                },
              },
            },
          },
        },
      },
      searchConfig: { cacheTtlMinutes: 0 },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await expect(tool.execute({ query: "wrong local endpoint" })).rejects.toThrow();
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

  it.each([
    { name: "a non-string value", query: { value: 123 } },
    {
      name: "a throwing getter",
      query: {
        get() {
          throw new Error("Unrelated inherited contents option was accessed");
        },
      },
    },
  ])("ignores inherited text query with $name", ({ query }) => {
    const prototype = Object.defineProperty({}, "query", query);
    const text = Object.assign(Object.create(prototype), { maxCharacters: 1 });

    expect(testing.parseExaContents({ text })).toEqual({
      value: { text: { maxCharacters: 1 } },
    });
  });

  it("keeps uncapped content values owned by the pinned provider", () => {
    const query = "q".repeat(5000);
    expect(
      testing.parseExaContents({
        text: { maxCharacters: 100001 },
        highlights: {
          maxCharacters: 100001,
          query,
          numSentences: 101,
          highlightsPerUrl: 101,
        },
        summary: { query },
      }),
    ).toEqual({
      value: {
        text: { maxCharacters: 100001 },
        highlights: {
          maxCharacters: 100001,
          query,
          numSentences: 101,
          highlightsPerUrl: 101,
        },
        summary: { query },
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
      message: "contents.highlights.numSentences must be a positive integer.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("exposes newer documented Exa search types and count limits", () => {
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

    const parameters = tool.parameters as {
      properties?: {
        count?: { maximum?: number };
        type?: { enum?: string[] };
      };
    };

    expect(parameters.properties?.count?.maximum).toBe(100);
    expect(parameters.properties?.type?.enum).toEqual([
      "auto",
      "neural",
      "fast",
      "deep",
      "deep-reasoning",
      "instant",
    ]);
    expect(testing.resolveExaSearchCount(80, 10)).toBe(80);
    expect(testing.resolveExaSearchCount(120, 10)).toBe(100);
    expect(testing.resolveExaSearchCount("+05", 10)).toBe(5);
    expect(testing.resolveExaSearchCount("0x10", 10)).toBe(10);
    expect(testing.resolveExaSearchCount("1e2", 10)).toBe(10);
    expect(testing.resolveExaSearchCount(1.5, 10)).toBe(10);
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
