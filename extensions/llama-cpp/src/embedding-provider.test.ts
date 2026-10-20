import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  prepareServer: vi.fn(),
  inspectRuntime: vi.fn(),
  genericCreate: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/embedding-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/embedding-providers")>()),
  getEmbeddingProvider: () => ({ create: mocks.genericCreate }),
}));

vi.mock("./managed-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-server.js")>()),
  ensureLlamaCppModel: mocks.ensureModel,
  prepareManagedLlamaServer: mocks.prepareServer,
  inspectLlamaServerRuntime: mocks.inspectRuntime,
}));

import { DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, LLAMA_CPP_PROVIDER_ID } from "./defaults.js";
import { llamaCppEmbeddingProviderAdapter } from "./embedding-provider.js";

type GenericProvider = {
  id: string;
  model: string;
  embed: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
};

function managedOptions(port: number) {
  return {
    config: {
      models: {
        providers: {
          [LLAMA_CPP_PROVIDER_ID]: {
            api: "openai-completions" as const,
            apiKey: "llama-cpp-local",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            localService: {
              command: "/runtime/llama-server",
              args: ["--models-preset", "/runtime/models.ini"],
              healthUrl: `http://127.0.0.1:${port}/health`,
            },
            models: [],
          },
        },
      },
    },
    provider: "local",
    model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  };
}

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("managed llama.cpp embedding provider", () => {
  const order: string[] = [];
  const inFlight: Array<{ slice: string[]; release: () => void }> = [];
  let generic: GenericProvider;

  beforeEach(() => {
    order.length = 0;
    inFlight.length = 0;
    mocks.ensureModel.mockResolvedValue("/models/model.gguf");
    mocks.prepareServer.mockResolvedValue({});
    mocks.inspectRuntime.mockResolvedValue({ engine: "llama.cpp", state: "ready" });
    generic = {
      id: "openai-compatible",
      model: "embeddinggemma-300m-qat-q8_0",
      embed: vi.fn(async () => {
        order.push("query");
        return [0.6, 0.8];
      }),
      embedBatch: vi.fn(async (inputs: string[]) => {
        order.push(`batch:${inputs.join("")}`);
        const completion = createDeferred<void>();
        inFlight.push({ slice: inputs, release: completion.resolve });
        await completion.promise;
        return inputs.map((input) => [input.length]);
      }),
    };
    mocks.genericCreate.mockResolvedValue({
      provider: generic,
      runtime: { id: "openai-compatible" },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends index batches as short serialized sub-requests and lets a query jump ahead", async () => {
    const created = await llamaCppEmbeddingProviderAdapter.create(managedOptions(19460));
    const provider = created.provider;
    expect(provider).toBeDefined();
    if (!provider) {
      return;
    }

    const batch = provider.embedBatch(["a", "b", "c"], { inputType: "document" });
    await flush();
    expect(order).toEqual(["batch:ab"]);

    const query = provider.embed("q", { inputType: "query" });
    await flush();
    expect(order).toEqual(["batch:ab", "query"]);
    expect(await query).toEqual([0.6, 0.8]);

    inFlight[0]?.release();
    await flush();
    expect(order).toEqual(["batch:ab", "query", "batch:c"]);
    inFlight[1]?.release();
    expect(await batch).toEqual([[1], [1], [1]]);
    expect(generic.embedBatch).toHaveBeenCalledTimes(2);
    expect(generic.embedBatch.mock.calls.map((call) => call[1])).toEqual([
      { inputType: "document" },
      { inputType: "document" },
    ]);
    // Runtime facts refresh once per batch and once per query, not per sub-request.
    expect(mocks.inspectRuntime).toHaveBeenCalledTimes(2);
  });

  it("embeds queries on the query lane of a managed preset and falls back to the main model", async () => {
    mocks.prepareServer.mockResolvedValue({
      queryEmbeddingModel: "embeddinggemma-300m-qat-q8_0-query",
    });
    const lane = {
      ...generic,
      model: "embeddinggemma-300m-qat-q8_0-query",
      embed: vi.fn(async () => [0, 1]),
    };
    mocks.genericCreate.mockImplementation(async ({ model }: { model: string }) => ({
      provider: model.endsWith("-query") ? lane : generic,
      runtime: { id: "openai-compatible" },
    }));
    const provider = (await llamaCppEmbeddingProviderAdapter.create(managedOptions(19462)))
      .provider;
    expect(provider).toBeDefined();
    if (!provider) {
      return;
    }
    expect(mocks.genericCreate.mock.calls.map(([options]) => options.model)).toEqual([
      "embeddinggemma-300m-qat-q8_0",
      "embeddinggemma-300m-qat-q8_0-query",
    ]);

    expect(await provider.embed("q", { inputType: "query" })).toEqual([0, 1]);
    expect(generic.embed).not.toHaveBeenCalled();

    lane.embed.mockRejectedValueOnce(new Error("input is too large"));
    expect(await provider.embed("long", { inputType: "query" })).toEqual([0.6, 0.8]);
    // A failed lane rests; the next query goes straight to the main model.
    expect(await provider.embed("next", { inputType: "query" })).toEqual([0.6, 0.8]);
    expect(lane.embed).toHaveBeenCalledTimes(2);
    expect(generic.embed).toHaveBeenCalledTimes(2);
  });

  it("keeps queries on the main model when the preset has no query lane", async () => {
    const provider = (await llamaCppEmbeddingProviderAdapter.create(managedOptions(19463)))
      .provider;
    expect(await provider?.embed("q", { inputType: "query" })).toEqual([0.6, 0.8]);
    expect(mocks.genericCreate).toHaveBeenCalledTimes(1);
  });

  it("serializes index batches from every manager that shares the same server", async () => {
    const first = (await llamaCppEmbeddingProviderAdapter.create(managedOptions(19461))).provider;
    const second = (await llamaCppEmbeddingProviderAdapter.create(managedOptions(19461))).provider;
    expect(first && second).toBeTruthy();
    if (!first || !second) {
      return;
    }

    const left = first.embedBatch(["a", "b"], { inputType: "document" });
    const right = second.embedBatch(["c"], { inputType: "document" });
    await flush();
    expect(order).toEqual(["batch:ab"]);
    inFlight[0]?.release();
    await flush();
    expect(order).toEqual(["batch:ab", "batch:c"]);
    inFlight[1]?.release();
    expect(await left).toEqual([[1], [1]]);
    expect(await right).toEqual([[1]]);
  });
});
