import { createHash } from "node:crypto";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const BASE = "http://127.0.0.1:4210";
const JSON_RESPONSE_MAX_BYTES = 64 * 1024;
const ACTION_TIMEOUT_MS = 2 * 60 * 1000;
export class ArxiBridgeError extends Error {
  constructor(readonly status: number) {
    super(`Arxi bridge rejected request (${status})`);
  }
}

export type ArxiInboundEvent = {
  version: 1;
  event_id: string;
  conversation_id: string;
  runtime_generation: number;
  content_sha256: string;
  telegram: { messages?: Array<Record<string, unknown>> };
  attachments: Array<{
    id: string;
    kind: string;
    name: string;
    media_type: string;
    size_bytes: number;
    sha256: string;
    content_url: string;
  }>;
};

async function bridgeFetch(params: {
  path: string;
  init: RequestInit;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  return await fetchWithSsrFGuard({
    url: BASE + params.path,
    init: params.init,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    maxRedirects: 0,
    policy: { allowedOrigins: [BASE] },
    auditContext: "arxi.guest-bridge",
  });
}

async function responseJson(response: Response): Promise<unknown> {
  const body = await readResponseWithLimit(response, JSON_RESPONSE_MAX_BYTES);
  return JSON.parse(body.toString("utf8"));
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeInboundAttachment(value: unknown): ArxiInboundEvent["attachments"][number] {
  if (
    !objectRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.name !== "string" ||
    typeof value.media_type !== "string" ||
    !Number.isSafeInteger(value.size_bytes) ||
    Number(value.size_bytes) <= 0 ||
    typeof value.sha256 !== "string" ||
    typeof value.content_url !== "string"
  ) {
    throw new Error("Arxi inbound attachment is invalid");
  }
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    media_type: value.media_type,
    size_bytes: Number(value.size_bytes),
    sha256: value.sha256,
    content_url: value.content_url,
  };
}

function decodeInboundEvent(value: unknown): ArxiInboundEvent {
  if (
    !objectRecord(value) ||
    value.version !== 1 ||
    typeof value.event_id !== "string" ||
    typeof value.conversation_id !== "string" ||
    !Number.isSafeInteger(value.runtime_generation) ||
    Number(value.runtime_generation) <= 0 ||
    typeof value.content_sha256 !== "string" ||
    !objectRecord(value.telegram) ||
    !Array.isArray(value.attachments)
  ) {
    throw new Error("Arxi inbound event is invalid");
  }
  const messages = value.telegram.messages;
  if (messages !== undefined && (!Array.isArray(messages) || !messages.every(objectRecord))) {
    throw new Error("Arxi inbound Telegram context is invalid");
  }
  return {
    version: 1,
    event_id: value.event_id,
    conversation_id: value.conversation_id,
    runtime_generation: Number(value.runtime_generation),
    content_sha256: value.content_sha256,
    telegram: { messages },
    attachments: value.attachments.map(decodeInboundAttachment),
  };
}

function decodeUploadReceipt(value: unknown): { size_bytes: number; sha256: string } {
  if (
    !objectRecord(value) ||
    !Number.isSafeInteger(value.size_bytes) ||
    Number(value.size_bytes) <= 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) {
    throw new Error("Arxi upload receipt is invalid");
  }
  return { size_bytes: Number(value.size_bytes), sha256: value.sha256 };
}

export async function pollInbound(signal: AbortSignal): Promise<ArxiInboundEvent | null> {
  const { response, release } = await bridgeFetch({
    path: "/v1/inbound/poll",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wait_ms: 20_000 }),
    },
    signal,
    timeoutMs: 25_000,
  });
  try {
    if (response.status === 204) {
      return null;
    }
    if (!response.ok) {
      throw new ArxiBridgeError(response.status);
    }
    return decodeInboundEvent(await responseJson(response));
  } finally {
    await release();
  }
}
export async function acceptInbound(event: ArxiInboundEvent, signal?: AbortSignal) {
  const { response, release } = await bridgeFetch({
    path: "/v1/inbound/accepted",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: event.event_id, content_sha256: event.content_sha256 }),
    },
    signal,
    timeoutMs: 10_000,
  });
  try {
    if (!response.ok) {
      throw new ArxiBridgeError(response.status);
    }
  } finally {
    await release();
  }
}
export async function readInboundFile(attachment: ArxiInboundEvent["attachments"][number]) {
  if (!attachment.content_url.startsWith("/v1/inbound-files/")) {
    throw new Error("Arxi inbound file path is invalid");
  }
  const { response, release } = await bridgeFetch({
    path: attachment.content_url,
    init: { method: "GET" },
    timeoutMs: 30_000,
  });
  try {
    if (!response.ok) {
      throw new ArxiBridgeError(response.status);
    }
    const content = await readResponseWithLimit(response, attachment.size_bytes);
    if (
      content.length !== attachment.size_bytes ||
      createHash("sha256").update(content).digest("hex") !== attachment.sha256
    ) {
      throw new Error("Arxi inbound file content mismatch");
    }
    return content;
  } finally {
    await release();
  }
}

export async function submitAction(action: unknown) {
  const { response, release } = await bridgeFetch({
    path: "/v1/actions",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    },
    timeoutMs: ACTION_TIMEOUT_MS,
  });
  try {
    if (!response.ok) {
      throw new ArxiBridgeError(response.status);
    }
  } finally {
    await release();
  }
}
export async function uploadActionFile(
  actionId: string,
  name: string,
  mediaType: string,
  content: Buffer,
) {
  const { response, release } = await bridgeFetch({
    path: `/v1/action-files/${encodeURIComponent(actionId)}`,
    init: {
      method: "PUT",
      headers: { "content-type": mediaType, "x-arxi-file-name": name },
      body: new Uint8Array(content),
    },
    timeoutMs: 30_000,
  });
  try {
    if (!response.ok) {
      throw new ArxiBridgeError(response.status);
    }
    return decodeUploadReceipt(await responseJson(response));
  } finally {
    await release();
  }
}
