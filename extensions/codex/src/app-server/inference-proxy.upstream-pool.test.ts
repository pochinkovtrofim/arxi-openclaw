import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  request,
  type IncomingMessage,
  type RequestListener,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import tls from "node:tls";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";

// The fixture certificate names files.proxy.test; the CONNECT proxy below tunnels it to
// the local origin, so the relay runs its real env-proxy, tunnel and TLS path.
const FIXTURE_HOST = "files.proxy.test";
type Observed = {
  pool: unknown;
  mode: unknown;
  connection?: { reused: boolean; connectMs?: number };
};
const observed = vi.hoisted(() => ({ requests: [] as Observed[] }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      const source = new URL(params.url);
      expect(source.origin).toBe("https://api.openai.com");
      const target = new URL(source.pathname + source.search, `https://${FIXTURE_HOST}`);
      const entry: Observed = { pool: params.dispatcherPool, mode: params.mode };
      observed.requests.push(entry);
      const result = await actual.fetchWithSsrFGuard({ ...params, url: target.href });
      entry.connection = result.connection;
      return result;
    },
  };
});

type SetDefaultCaCertificates = (certificates: string[]) => void;
const setDefaultCaCertificates = Reflect.get(tls, "setDefaultCACertificates") as
  | SetDefaultCaCertificates
  | undefined;
const getCaCertificates = Reflect.get(tls, "getCACertificates") as
  | ((type: "default") => string[])
  | undefined;
const defaultCertificates = getCaCertificates?.("default");

const child = {
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn",
      thread_id: "child",
      parent_thread_id: "parent",
    }),
  },
};

let proxy: CodexInferenceProxy;
let origin: ReturnType<typeof createHttpsServer>;
let tunnelServer: ReturnType<typeof createHttpServer>;
let handle: RequestListener;
let tunnels: Socket[];
let handshakes: number;
let originRequests: number;
const sockets = new Set<Socket>();

// Lets loopback close and response-release events settle before the next request.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function track(socket: Socket) {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
}

async function listen(server: ReturnType<typeof createHttpServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

beforeAll(() => {
  assert(setDefaultCaCertificates && defaultCertificates);
  setDefaultCaCertificates([...defaultCertificates, PROXY_FIXTURE_CERTIFICATE]);
});

afterAll(() => {
  if (setDefaultCaCertificates && defaultCertificates) {
    setDefaultCaCertificates(defaultCertificates);
  }
});

beforeEach(async () => {
  observed.requests = [];
  tunnels = [];
  handshakes = 0;
  originRequests = 0;
  handle = (req, res) => {
    req.resume();
    req.once("end", () => res.end("data: synthetic completion\n\n"));
  };
  origin = createHttpsServer(
    { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
    (req, res) => {
      originRequests++;
      handle(req, res);
    },
  );
  origin.keepAliveTimeout = 120_000;
  origin.on("connection", track);
  origin.on("secureConnection", () => handshakes++);
  const originPort = await listen(origin);
  tunnelServer = createHttpServer();
  tunnelServer.on("connection", track);
  tunnelServer.on("connect", (req, client: Socket, head) => {
    if (req.url !== `${FIXTURE_HOST}:443`) {
      client.destroy();
      return;
    }
    tunnels.push(client);
    const upstream = connect(originPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    track(upstream);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  const proxyUrl = `http://127.0.0.1:${await listen(tunnelServer)}`;
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    vi.stubEnv(name, proxyUrl);
  }
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent: () => {},
  });
});

afterEach(async () => {
  proxy.close();
  for (const socket of sockets) {
    socket.destroy();
  }
  await Promise.all(
    [origin, tunnelServer].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  vi.unstubAllEnvs();
});

async function post(body: object = child) {
  const response = createDeferred<IncomingMessage>();
  const req = request(
    proxy.baseUrl + "/responses",
    { method: "POST", agent: false },
    response.resolve,
  );
  req.once("error", response.reject);
  req.end(JSON.stringify(body));
  const res = await response.promise;
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(Buffer.from(chunk));
  }
  return { status: res.statusCode, body: Buffer.concat(chunks).toString() };
}

describe("inference relay upstream connection reuse", () => {
  it("carries sequential requests over one tunnel and one TLS handshake", async () => {
    for (let index = 0; index < 4; index++) {
      expect(await post()).toEqual({ status: 200, body: "data: synthetic completion\n\n" });
    }
    expect(originRequests).toBe(4);
    expect(tunnels).toHaveLength(1);
    expect(handshakes).toBe(1);
    expect(observed.requests.map((entry) => entry.mode)).toEqual(
      Array(4).fill("trusted_env_proxy"),
    );
    const [first, ...rest] = observed.requests.map((entry) => entry.connection);
    expect(first).toEqual({ reused: false, connectMs: expect.any(Number) });
    expect(rest).toEqual(Array(3).fill({ reused: true }));
  });

  it("keeps the pool private to one relay", async () => {
    const other = await createCodexInferenceProxy({
      upstream: new URL("https://api.openai.com/v1"),
      assertCurrent: () => {},
    });
    try {
      await post();
      const response = createDeferred<IncomingMessage>();
      request(other.baseUrl + "/responses", { method: "POST", agent: false }, response.resolve)
        .once("error", response.reject)
        .end(JSON.stringify(child));
      (await response.promise).resume();
      await vi.waitFor(() => expect(observed.requests[1]?.connection).toBeDefined());
    } finally {
      other.close();
    }
    const [first, second] = observed.requests;
    assert(first && second);
    expect(first.pool).toBeDefined();
    expect(second.pool).toBeDefined();
    expect(second.pool).not.toBe(first.pool);
    expect(second.connection).toEqual({ reused: false, connectMs: expect.any(Number) });
    expect(tunnels).toHaveLength(2);
  });

  it("reconnects transparently after the tunnel closes while idle", async () => {
    expect((await post()).status).toBe(200);
    const [tunnel] = tunnels;
    assert(tunnel);
    const closed = once(tunnel, "close");
    tunnel.destroy();
    await closed;
    // Let the relay observe the close before it chooses a socket for the next request.
    await settle();
    expect(await post()).toEqual({ status: 200, body: "data: synthetic completion\n\n" });
    expect(originRequests).toBe(2);
    expect(tunnels).toHaveLength(2);
    expect(observed.requests[1]?.connection).toEqual({
      reused: false,
      connectMs: expect.any(Number),
    });
  });

  it("never re-sends a request body the upstream already received", async () => {
    expect((await post()).status).toBe(200);
    // The pooled connection drops after the whole request arrives and before any response.
    handle = (req) => {
      req.resume();
      req.once("end", () => req.socket.destroy());
    };
    expect(await post()).toEqual({ status: 502, body: expect.any(String) });
    expect(originRequests).toBe(2);
    expect(tunnels).toHaveLength(1);
    // A later request opens a fresh tunnel; the failed one was not replayed on it.
    handle = (req, res) => {
      req.resume();
      req.once("end", () => res.end("data: synthetic completion\n\n"));
    };
    expect((await post()).status).toBe(200);
    expect(originRequests).toBe(3);
    expect(tunnels).toHaveLength(2);
  });

  it("opens one-shot tunnels instead of queueing behind four pooled streams", async () => {
    const streams: Array<() => void> = [];
    const opened = createDeferred<void>();
    handle = (req, res) => {
      req.resume();
      req.once("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: synthetic delta\n\n");
        streams.push(() => res.end("data: synthetic completion\n\n"));
        if (streams.length === 6) {
          opened.resolve();
        }
      });
    };
    const requests = Array.from({ length: 6 }, () => post());
    // All six reach the origin while the first four still stream.
    await opened.promise;
    expect(tunnels).toHaveLength(6);
    for (const end of streams) {
      end();
    }
    expect((await Promise.all(requests)).every((result) => result.status === 200)).toBe(true);
    const pooled = observed.requests.filter((entry) => entry.connection !== undefined);
    expect(pooled).toHaveLength(4);
    // Released pooled sockets serve the next request without a new tunnel.
    handle = (req, res) => {
      req.resume();
      req.once("end", () => res.end("data: synthetic completion\n\n"));
    };
    await settle();
    expect((await post()).status).toBe(200);
    expect(tunnels).toHaveLength(6);
    expect(observed.requests.at(-1)?.connection).toEqual({ reused: true });
  });
});
