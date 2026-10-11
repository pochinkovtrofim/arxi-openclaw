import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { createEnvProxyTunnelPool, fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

// One upstream tunnel and TLS session serves sequential model requests. Egress closes a
// tunnel 10 min after it opens, so a pooled socket takes new requests for its first
// 2 min only, leaving each stream at least 8 min. A busy pool falls back to a fresh
// tunnel per request rather than queueing behind a stream.
const UPSTREAM_IDLE_MS = 60_000;
const UPSTREAM_MAX_REUSE_AGE_MS = 120_000;
const UPSTREAM_POOLED_CONNECTIONS = 4;
const upstreamLog = createSubsystemLogger("codex/inference");

type GuardedUpstream = Awaited<ReturnType<typeof fetchWithSsrFGuard>>;

/** The relay's guarded upstream fetch, with a tunnel pool private to one relay. */
export function createCodexUpstreamTransport() {
  const pool = createEnvProxyTunnelPool({
    maxEntries: 2,
    idleTtlMs: UPSTREAM_IDLE_MS,
    maxAgeMs: UPSTREAM_MAX_REUSE_AGE_MS,
    maxActiveLeases: UPSTREAM_POOLED_CONNECTIONS,
  });
  return {
    async fetch(
      target: URL,
      init: RequestInit & { duplex: "half" },
      signal: AbortSignal,
      beforeRequest: () => void,
    ): Promise<GuardedUpstream> {
      const startedAt = performance.now();
      const guarded = await fetchWithSsrFGuard({
        url: target.toString(),
        init,
        signal,
        beforeRequest,
        requireHttps: true,
        maxRedirects: 0,
        capture: false,
        mode: "trusted_env_proxy",
        auditContext: "codex-parent-local-inference",
        dispatcherPool: pool,
      });
      logUpstreamRequest(guarded, performance.now() - startedAt);
      return guarded;
    },
    close(): void {
      void pool.closeAll();
    },
  };
}

/** Content-free upstream transport timing: no URL, headers, identity or body. */
function logUpstreamRequest(guarded: GuardedUpstream, ttfbMs: number): void {
  const connection = guarded.connection;
  upstreamLog.debug("upstream request", {
    // An unpooled request (no proxy, or a busy pool) opened its own connection.
    pooled: connection !== undefined,
    reused: connection?.reused ?? false,
    ...(connection?.connectMs !== undefined ? { connect_ms: connection.connectMs } : {}),
    ttfb_ms: Math.round(ttfbMs),
    status_class: `${Math.floor(guarded.response.status / 100)}xx`,
  });
}
