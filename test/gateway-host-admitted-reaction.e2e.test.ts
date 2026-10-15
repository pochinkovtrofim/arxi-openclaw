import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { GatewayClient } from "../src/gateway/client.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TOKEN = "host-admitted-reaction-token";
const instances: OpenClawTestInstance[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function writeReact(res: ServerResponse): void {
  const item = {
    type: "function_call",
    id: "fc_react",
    call_id: "call_react",
    // The message tool is deferred behind tool search, as on Owner runtimes.
    name: "tool_call",
    arguments: JSON.stringify({ id: "message", args: { action: "react", emoji: "👍", final: true } }),
    status: "completed",
  };
  writeOpenAiResponsesSse(res, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_react",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

function writeText(res: ServerResponse, text: string, index: number): void {
  const message = {
    type: "message",
    id: `msg_after_react_${index}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeOpenAiResponsesSse(res, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_after_react_${index}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startModel(finalText: string) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "reaction", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      requests.push(await readJson(req));
      if (requests.length === 1) {
        writeReact(res);
      } else {
        writeText(res, finalText, requests.length);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("model did not bind");
  }
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

// A channel plugin shaped like Arxi's: one direct logical target, a react action,
// and outbound text. It records what reaches the plugin.
async function writeChannelPlugin(dir: string, tracePath: string): Promise<void> {
  await writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "arxi",
      name: "Arxi probe",
      description: "Records host-admitted channel actions",
      activation: { onStartup: true },
      channels: ["arxi"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      channelConfigs: {
        arxi: {
          label: "Arxi",
          description: "probe",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { enabled: { type: "boolean" } },
          },
        },
      },
    }),
  );
  const trace = JSON.stringify(tracePath);
  await writeFile(
    path.join(dir, "index.mjs"),
    `import { appendFileSync } from "node:fs";
import { createChatChannelPlugin, defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
const record = (entry) => appendFileSync(${trace}, JSON.stringify(entry) + "\\n");
const account = { accountId: "default", enabled: true, configured: true };
const plugin = createChatChannelPlugin({
  base: {
    id: "arxi",
    meta: { id: "arxi", label: "Arxi", selectionLabel: "Arxi", docsPath: "/channels/arxi", blurb: "probe" },
    capabilities: { chatTypes: ["direct"], media: false, blockStreaming: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => account,
      defaultAccountId: () => "default",
      isConfigured: () => true,
      resolveAllowFrom: () => ["owner"],
      resolveDefaultTo: () => "owner",
    },
    messaging: {
      normalizeTarget: (raw) => (raw?.trim() === "owner" ? "owner" : undefined),
      inferTargetChatType: () => "direct",
      targetResolver: { looksLikeId: (raw) => raw?.trim() === "owner", hint: "owner" },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["react"] }),
      supportsAction: ({ action }) => action === "react",
      handleAction: async (ctx) => {
        record({ kind: "action", action: ctx.action, params: ctx.params, sessionKey: ctx.sessionKey, runId: ctx.runId,
          toolContext: ctx.toolContext ? { ...ctx.toolContext, hasRepliedRef: undefined } : null });
        return jsonResult({ ok: true, added: ctx.params?.emoji });
      },
    },
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: "arxi",
      sendText: async (ctx) => {
        record({ kind: "text", text: ctx.text, to: ctx.to });
        return { messageId: "sent-" + Date.now() };
      },
    },
  },
});
export default defineChannelPluginEntry({ id: "arxi", name: "Arxi probe", description: "probe", plugin });
`,
  );
}

async function readTrace(tracePath: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function connectHost(instance: OpenClawTestInstance): Promise<GatewayClient> {
  let resolveHello!: () => void;
  let rejectHello!: (error: Error) => void;
  const hello = new Promise<void>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  // The Arxi guest connects over loopback as a backend with the admin scope.
  const client = new GatewayClient({
    url: instance.url,
    token: TOKEN,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    deviceIdentity: null,
    role: "operator",
    scopes: ["operator.admin"],
    requestTimeoutMs: 60_000,
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
    onClose: (code, reason) => rejectHello(new Error(`Gateway closed ${code}: ${reason}`)),
  });
  cleanups.push(async () => {
    client.stop();
  });
  client.start();
  await hello;
  return client;
}

describe("host-admitted reaction", () => {
  it.each(["", "NO_REPLY"])(
    "reaches the channel plugin with the admitted message (final text %j)",
    async (finalText) => {
      const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-host-reaction-"));
      cleanups.push(() => rm(fixtureDir, { recursive: true, force: true }));
      const pluginDir = path.join(fixtureDir, "plugin");
      const tracePath = path.join(fixtureDir, "trace.ndjson");
      await mkdir(pluginDir, { recursive: true });
      await writeChannelPlugin(pluginDir, tracePath);
      const model = await startModel(finalText);
      const modelRef = "reaction/reaction";
      const config = {
        channels: { arxi: { enabled: true } },
        plugins: {
          enabled: true,
          allow: ["arxi"],
          load: { paths: [pluginDir] },
          entries: { arxi: { enabled: true } },
          slots: { memory: "none" },
        },
        agents: {
          defaults: {
            workspace: path.join(fixtureDir, "workspace"),
            model: { primary: modelRef },
            modelPolicy: { allow: [modelRef] },
            models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
            skills: [],
            skipBootstrap: true,
          },
          entries: { main: { model: { primary: modelRef }, skills: [] } },
        },
        tools: { profile: "messaging" },
        models: {
          mode: "replace",
          providers: {
            reaction: {
              baseUrl: `${model.baseUrl}/v1`,
              apiKey: "model-key",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "reaction",
                  name: "reaction",
                  api: "openai-responses",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4_096,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig;
      const instance = await createOpenClawTestInstance({
        name: "host-admitted-reaction",
        gatewayToken: TOKEN,
        config,
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);
      await instance.startGateway();
      const client = await connectHost(instance);

      const accepted = await client.request<{ runId?: string; status?: string }>("agent", {
        message: "Thanks, that settles it",
        agentId: "main",
        sessionKey: "agent:main:external:reaction-probe",
        idempotencyKey: `external:reaction-probe-${finalText || "empty"}`,
        deliver: true,
        channel: "arxi",
        to: "owner",
        bestEffortDeliver: false,
        admittedConversationId: "owner-conversation",
        admittedRequesterSenderId: "owner:probe",
        admittedMessageId: "4242",
      });
      const terminal = await client.request<Record<string, unknown>>(
        "agent.wait",
        { runId: accepted.runId, timeoutMs: 60_000 },
        { timeoutMs: 65_000 },
      );
      const trace = await readTrace(tracePath);
      const toolOutput = JSON.stringify(
        model.requests.map((request) =>
          (Array.isArray(request.input) ? request.input : []).filter(
            (item: { type?: string }) =>
              item?.type === "function_call_output" || item?.type === "function_call",
          ),
        ),
      );
      const observation = JSON.stringify({
          finalText,
          accepted,
          terminal,
          modelRequests: model.requests.length,
          reactToolOutput: toolOutput.slice(0, 6000),
          trace,
        });
      expect(trace.filter((entry) => entry.kind === "action"), `OBS ${observation}`).toEqual([
        expect.objectContaining({
          action: "react",
          runId: accepted.runId,
          toolContext: expect.objectContaining({ currentMessageId: "4242" }),
        }),
      ]);
      // A reaction is the whole answer: nothing else reaches the Owner.
      expect(trace.filter((entry) => entry.kind === "text"), `OBS ${observation}`).toEqual([]);
      // A final reaction settles the turn: no empty-reply retry or host summary.
      expect(model.requests.length, `OBS ${observation}`).toBe(2);
    },
    150_000,
  );
});
