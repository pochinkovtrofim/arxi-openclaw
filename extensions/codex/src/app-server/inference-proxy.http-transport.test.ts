import { EventEmitter, once } from "node:events";
import { createServer, request, type IncomingMessage } from "node:http";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  type ClientOptions,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";

const transport = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolve: vi.fn(),
  upstream: "",
  dials: [] as string[],
  // Shortened receipt bounds for the relay listener only; fixture servers keep Node defaults.
  relayServerOptions: undefined as Record<string, number> | undefined,
}));
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      if (transport.relayServerOptions && typeof args[0] === "function") {
        // The relay assigns its receipt bounds after construction; pin the shortened
        // ones so the test can prove they cover request receipt only.
        for (const [key, value] of Object.entries(transport.relayServerOptions)) {
          Object.defineProperty(server, key, {
            get: () => value,
            set: () => {},
            configurable: true,
          });
        }
      }
      return server;
    },
  };
});
vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({ createNodeProxyAgent: () => undefined }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    fetchWithSsrFGuard: transport.fetch,
    isBlockedHostnameOrIp: actual.isBlockedHostnameOrIp,
    resolvePinnedHostnameWithPolicy: transport.resolve,
  };
});
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocket: class extends actual.WebSocket {
      constructor(url: string | URL, options?: ClientOptions) {
        const value = String(url);
        if (value.startsWith("wss:")) {
          transport.dials.push(value);
          super(transport.upstream, options);
        } else {
          super(url, options);
        }
      }
    },
  };
});

// Native HTTP Responses requests: full input and a stable prompt_cache_key on every call.
const child = {
  type: "response.create",
  model: "synthetic-model",
  prompt_cache_key: "thread-root",
  store: false,
  stream: true,
  input: [{ role: "user", content: "synthetic turn" }],
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "child",
      parent_thread_id: "parent",
      request_kind: "turn",
    }),
  },
};
const proxies: CodexInferenceProxy[] = [];

type UpstreamRequest = {
  body: Buffer;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
};

beforeEach(() => {
  transport.fetch.mockReset();
  transport.resolve.mockReset().mockResolvedValue({
    hostname: "api.openai.com",
    addresses: ["127.0.0.1"],
    lookup: undefined,
  });
  transport.dials = [];
  transport.relayServerOptions = undefined;
  transport.fetch.mockImplementation(async (args) => {
    await new Response(args.init.body).arrayBuffer();
    return { response: new Response("synthetic completion"), release: async () => {} };
  });
});
afterEach(() => {
  for (const proxy of proxies.splice(0)) {
    proxy.close();
  }
});

async function relay(inferenceTransport?: "websocket" | "http") {
  const proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent: () => {},
    ...(inferenceTransport ? { inferenceTransport } : {}),
  });
  proxies.push(proxy);
  return proxy;
}

/** Upstream fixture: every call streams a controllable SSE body under the given headers. */
function streamingUpstream(headers: Record<string, string> = {}) {
  const changed = new EventEmitter();
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: UpstreamRequest[] = [];
  const state = { cancelled: 0, released: 0 };
  transport.fetch.mockImplementation(async (args) => {
    const body = Buffer.from(await new Response(args.init.body).arrayBuffer());
    requests.push({ body, headers: args.init.headers, signal: args.signal });
    return {
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            changed.emit("request");
          },
          cancel() {
            state.cancelled++;
            changed.emit("cancel");
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream", ...headers } },
      ),
      release: async () => {
        state.released++;
        changed.emit("release");
      },
    };
  });
  const send = (index: number, text: string) => {
    controllers[index]?.enqueue(new TextEncoder().encode(text));
  };
  return {
    controllers,
    requests,
    state,
    send,
    async waitFor(event: "request" | "cancel" | "release", count: number) {
      const current = () =>
        event === "request"
          ? controllers.length
          : event === "cancel"
            ? state.cancelled
            : state.released;
      while (current() < count) {
        await once(changed, event);
      }
    },
  };
}

function post(proxy: CodexInferenceProxy, body: Buffer, headers: Record<string, string> = {}) {
  const response = createDeferred<IncomingMessage>();
  const closed = createDeferred<void>();
  const req = request(
    proxy.baseUrl + "/responses",
    { method: "POST", agent: false, headers },
    response.resolve,
  );
  req.once("error", response.reject);
  req.once("socket", (socket) => socket.once("close", () => closed.resolve()));
  req.end(body);
  return { req, response: response.promise, closed: closed.promise };
}

/** Collects a streaming response without ever leaving it flowing unobserved. */
function collect(response: IncomingMessage) {
  const changed = new EventEmitter();
  const chunks: string[] = [];
  const ended = createDeferred<void>();
  response.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk).toString());
    changed.emit("chunk");
  });
  response.once("end", () => ended.resolve());
  response.once("error", () => ended.resolve());
  return {
    chunks,
    ended: ended.promise,
    async waitFor(count: number) {
      while (chunks.length < count) {
        await once(changed, "chunk");
      }
    },
  };
}

async function upgrade(proxy: CodexInferenceProxy) {
  const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
  socket.on("error", () => {});
  try {
    const [, response] = (await once(socket, "unexpected-response")) as [unknown, IncomingMessage];
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.from(chunk));
    }
    return {
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks).toString(),
    };
  } finally {
    socket.terminate();
  }
}

describe("HTTP-only inference transport", () => {
  it("answers every WebSocket upgrade with 426 without dialing or charging a resident", async () => {
    const proxy = await relay("http");
    const rejection = await upgrade(proxy);
    expect(rejection.status).toBe(426);
    expect(rejection.headers).toMatchObject({ connection: "close", "content-type": "text/plain" });
    expect(rejection.body).toBe("Codex parent-local inference relay serves HTTP Responses only.");
    expect(transport.resolve).not.toHaveBeenCalled();
    expect(transport.dials).toEqual([]);
    // More refused handshakes than the relay has resident and pending slots (80 + 16).
    for (let attempt = 0; attempt < 100; attempt++) {
      expect((await upgrade(proxy)).status).toBe(426);
    }
    const upload = post(proxy, Buffer.from(JSON.stringify(child)));
    const response = await upload.response;
    expect(response.statusCode).toBe(200);
    await collect(response).ended;
    expect(response.complete).toBe(true);
    expect(transport.fetch).toHaveBeenCalledOnce();
    await upload.closed;
  });

  it("keeps relaying native WebSockets when the transport is not configured", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const upstreams: WebSocket[] = [];
    wss.on("connection", (socket) => upstreams.push(socket));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture did not listen");
    }
    transport.upstream = "ws://127.0.0.1:" + address.port;
    const proxy = await relay();
    const client = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
    client.on("error", () => {});
    try {
      await once(client, "open");
      expect(transport.dials).toEqual(["wss://api.openai.com/v1/responses"]);
      const upstream = upstreams.at(-1);
      if (!upstream) {
        throw new Error("fixture did not accept its upstream");
      }
      const received = once(upstream, "message");
      client.send(JSON.stringify(child));
      expect(JSON.parse(String((await received)[0]))).toEqual(child);
    } finally {
      client.terminate();
      for (const socket of wss.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("streams SSE through unchanged with the provider's rate-limit and turn-state headers", async () => {
    const upstream = streamingUpstream({
      "x-codex-primary-used-percent": "12",
      "x-codex-primary-reset-at": "1760054400",
      "x-codex-turn-state": "synthetic-turn-state",
      "X-Models-Etag": "synthetic-models-etag",
      "x-request-id": "req_synthetic",
    });
    const proxy = await relay("http");
    const upload = post(proxy, Buffer.from(JSON.stringify(child)), {
      accept: "text/event-stream",
      authorization: "Bearer synthetic-native-auth",
    });
    await upstream.waitFor("request", 1);
    const forwarded = upstream.requests[0];
    expect(JSON.parse(forwarded.body.toString())).toEqual(child);
    expect(forwarded.headers).toMatchObject({
      accept: "text/event-stream",
      authorization: "Bearer synthetic-native-auth",
    });
    upstream.send(0, "data: synthetic delta\n\n");
    const response = await upload.response;
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      connection: "close",
      "content-type": "text/event-stream",
      "x-codex-primary-used-percent": "12",
      "x-codex-primary-reset-at": "1760054400",
      "x-codex-turn-state": "synthetic-turn-state",
      "x-models-etag": "synthetic-models-etag",
      "x-request-id": "req_synthetic",
    });
    const body = collect(response);
    // The first event reaches native before the response completes.
    await body.waitFor(1);
    expect(body.chunks.join("")).toBe("data: synthetic delta\n\n");
    upstream.send(0, "data: synthetic completed\n\n");
    upstream.controllers[0]?.close();
    await body.ended;
    expect(body.chunks.join("")).toBe("data: synthetic delta\n\ndata: synthetic completed\n\n");
    expect(response.complete).toBe(true);
    await upload.closed;
  });

  it("admits zstd-compressed native request bodies", async () => {
    const upstream = streamingUpstream();
    const proxy = await relay("http");
    const wire = Buffer.from(JSON.stringify(child));
    const upload = post(proxy, zstdCompressSync(wire), { "content-encoding": "zstd" });
    await upstream.waitFor("request", 1);
    const forwarded = upstream.requests[0];
    expect(forwarded.headers["content-encoding"]).toBe("zstd");
    expect(zstdDecompressSync(forwarded.body)).toEqual(wire);
    upstream.controllers[0]?.close();
    const response = await upload.response;
    expect(response.statusCode).toBe(200);
    await collect(response).ended;
    await upload.closed;
  });

  it("bounds request receipt only, never a streaming response", async () => {
    transport.relayServerOptions = {
      requestTimeout: 300,
      headersTimeout: 200,
      connectionsCheckingInterval: 50,
    };
    const upstream = streamingUpstream();
    const proxy = await relay("http");
    const upload = post(proxy, Buffer.from(JSON.stringify(child)));
    await upstream.waitFor("request", 1);
    // The relay exposes downstream headers with the first response body chunk.
    upstream.send(0, "data: synthetic delta 0\n\n");
    const response = await upload.response;
    const body = collect(response);
    // Stream well past the shortened receipt bound: eight more events, 150 ms apart.
    for (let index = 1; index <= 8; index++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      upstream.send(0, `data: synthetic delta ${index}\n\n`);
      await body.waitFor(index + 1);
    }
    upstream.controllers[0]?.close();
    await body.ended;
    expect(response.complete).toBe(true);
    expect(body.chunks.join("")).toContain("data: synthetic delta 8");
    expect(upstream.state.cancelled).toBe(0);
    await upload.closed;
    // The same bound still applies while a request body is incomplete.
    const stalled = createDeferred<IncomingMessage>();
    const req = request(
      proxy.baseUrl + "/responses",
      { method: "POST", agent: false, headers: { "content-length": "64" } },
      stalled.resolve,
    );
    req.once("error", stalled.reject);
    req.write("{");
    const timedOut = await stalled.promise;
    expect(timedOut.statusCode).toBe(408);
    req.destroy();
    expect(upstream.requests).toHaveLength(1);
  }, 10_000);

  it("keeps 64 streaming model calls in flight without the busy path", async () => {
    const upstream = streamingUpstream();
    const proxy = await relay("http");
    const uploads = [];
    for (let index = 0; index < 64; index++) {
      const upload = post(proxy, Buffer.from(JSON.stringify(child)));
      await upstream.waitFor("request", index + 1);
      // Each call is admitted and already streaming before the next one starts.
      upstream.send(index, `data: synthetic delta ${index}\n\n`);
      const response = await upload.response;
      expect(response.statusCode).toBe(200);
      uploads.push({ ...upload, body: collect(response), response });
    }
    expect(upstream.controllers).toHaveLength(64);
    await Promise.all(uploads.map(({ body }) => body.waitFor(1)));
    for (const controller of upstream.controllers) {
      controller.close();
    }
    await Promise.all(uploads.map(({ body }) => body.ended));
    expect(uploads.every(({ response }) => response.complete)).toBe(true);
    await Promise.all(uploads.map(({ closed }) => closed));
  }, 20_000);

  it("aborts the upstream request when native drops its HTTP request mid-response", async () => {
    const upstream = streamingUpstream();
    const proxy = await relay("http");
    const upload = post(proxy, Buffer.from(JSON.stringify(child)));
    await upstream.waitFor("request", 1);
    upstream.send(0, "data: synthetic delta\n\n");
    const response = await upload.response;
    const body = collect(response);
    await body.waitFor(1);
    const signal = upstream.requests[0]?.signal;
    expect(signal?.aborted).toBe(false);
    // HTTP has no interrupt message: dropping the request is native's interrupt.
    response.destroy();
    await Promise.all([upstream.waitFor("cancel", 1), upstream.waitFor("release", 1)]);
    expect(signal?.aborted).toBe(true);
    await upload.closed;
  });
});
