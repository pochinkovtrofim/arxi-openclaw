// Request rewriting for guarded-fetch redirects: method, body and authorization carry-over.
import { normalizeHeadersInitForFetch, normalizeRequestInitHeadersForFetch } from "../fetch-headers.js";
import { retainSafeHeadersForCrossOriginRedirect as retainSafeRedirectHeaders } from "./redirect-headers.js";
import { matchesHostnameAllowlist } from "./ssrf.js";

export function retainSafeHeadersForCrossOriginRedirect(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) {
    return init;
  }
  return { ...init, headers: retainSafeRedirectHeaders(init.headers) };
}

export function resolveRetainedAuthorizationForRedirect(params: {
  init?: RequestInit;
  nextUrl: URL;
  hostnameAllowlist?: string[];
}): string | undefined {
  const init = params.init;
  if (!init?.headers || !params.hostnameAllowlist?.length) {
    return undefined;
  }
  if (params.nextUrl.protocol !== "https:") {
    return undefined;
  }
  if (
    !params.hostnameAllowlist.includes("*") &&
    !matchesHostnameAllowlist(params.nextUrl.hostname, params.hostnameAllowlist)
  ) {
    return undefined;
  }
  const normalizedInit = normalizeRequestInitHeadersForFetch(init);
  if (!normalizedInit?.headers) {
    return undefined;
  }
  return new Headers(normalizedInit.headers).get("authorization") ?? undefined;
}

export function restoreRedirectAuthorization(params: {
  init?: RequestInit;
  authorization?: string;
}): RequestInit | undefined {
  if (!params.authorization) {
    return params.init;
  }
  const headers = new Headers(params.init?.headers);
  headers.set("Authorization", params.authorization);
  return { ...params.init, headers };
}

function dropBodyHeaders(headers?: HeadersInit): HeadersInit | undefined {
  if (!headers) {
    return headers;
  }
  const nextHeaders = new Headers(normalizeHeadersInitForFetch(headers));
  nextHeaders.delete("content-encoding");
  nextHeaders.delete("content-language");
  nextHeaders.delete("content-length");
  nextHeaders.delete("content-location");
  nextHeaders.delete("content-type");
  nextHeaders.delete("transfer-encoding");
  return nextHeaders;
}

export function rewriteRedirectInit(params: {
  init?: RequestInit;
  status: number;
  crossOrigin: boolean;
  allowUnsafeReplay: boolean;
}): RequestInit | undefined {
  const { init, status } = params;
  if (!init) {
    return init;
  }

  const currentMethod = init.method?.toUpperCase() ?? "GET";
  const shouldForceGet =
    status === 303
      ? currentMethod !== "GET" && currentMethod !== "HEAD"
      : (status === 301 || status === 302) && currentMethod === "POST";

  const shouldDropUnsafeBody =
    params.crossOrigin &&
    !params.allowUnsafeReplay &&
    currentMethod !== "GET" &&
    currentMethod !== "HEAD";
  if (!shouldForceGet && !shouldDropUnsafeBody) {
    return init;
  }

  return {
    ...init,
    ...(shouldForceGet ? { method: "GET" } : {}),
    body: undefined,
    headers: dropBodyHeaders(init.headers),
  };
}
