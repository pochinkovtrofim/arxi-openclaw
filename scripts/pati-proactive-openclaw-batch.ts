/** One isolated QA gateway for a prepared Pati frozen holdout JSONL batch. */
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createQaGatewayChild } from "../extensions/qa-lab/src/gateway-child.js";
import { createQaGatewayCliError } from "../extensions/qa-lab/src/gateway-log-redaction.js";
import { startQaLabServer } from "../extensions/qa-lab/src/lab-server.js";
import { createQaTransportAdapter } from "../extensions/qa-lab/src/qa-transport-registry.js";
import { resolveQaGatewayTimeoutWithGraceMs } from "../extensions/qa-lab/src/timer-timeouts.js";

type PreparedInput = {
  authorizedSources: string[];
  messages: Array<{ ref: string; text?: string; unavailable?: boolean; [key: string]: unknown }>;
  revokedRefs: string[];
};
type Request = {
  id: string;
  input: PreparedInput;
  sourceIds?: Record<string, unknown>;
  visibleRefs?: string[];
};
type SessionUsage = {
  sessions?: Array<{
    key?: string;
    usage?: { totalCost?: number; totalTokens?: number; missingCostEntries?: number } | null;
  }>;
  cacheStatus?: unknown;
};
type History = { messages?: Array<Record<string, unknown>> };

function parseArgs(argv: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`expected --flag value at argument ${index + 1}`);
    }
    options.set(flag, value);
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (!value) {
      throw new Error(`missing ${key}`);
    }
    return value;
  };
  const timeoutMs = Number(options.get("--timeout-ms") ?? "120000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  const mode = required("--mode");
  if (mode !== "baseline" && mode !== "candidate") {
    throw new Error("--mode must be baseline or candidate");
  }
  const sourceSha = required("--source-sha");
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("--source-sha must be a full Git SHA");
  }
  const runtime = required("--runtime");
  if (runtime !== "codex" && runtime !== "openclaw") {
    throw new Error("--runtime must be codex or openclaw");
  }
  return {
    input: required("--input"),
    output: required("--output"),
    policyFile: required("--policy-file"),
    sourceSha,
    runtime: runtime as "codex" | "openclaw",
    mode,
    model: options.get("--model") ?? "openai/gpt-5.6-luna",
    timeoutMs,
  };
}

function readRequests(jsonl: string): Request[] {
  const ids = new Set<string>();
  return jsonl
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as Request).id !== "string" ||
        !(value as Request).id.trim() ||
        !(value as Request).input ||
        !Array.isArray((value as Request).input.authorizedSources) ||
        !Array.isArray((value as Request).input.messages) ||
        !Array.isArray((value as Request).input.revokedRefs) ||
        !(value as Request).input.messages.every(
          (message) =>
            message &&
            typeof message === "object" &&
            typeof message.ref === "string" &&
            Boolean(message.ref.trim()) &&
            (message.unavailable === true
              ? message.text === undefined
              : typeof message.text === "string"),
        )
      ) {
        throw new Error(`invalid prepared request at line ${index + 1}`);
      }
      const request = value as Request;
      if (ids.has(request.id)) {
        throw new Error(`duplicate request id at line ${index + 1}`);
      }
      ids.add(request.id);
      return request;
    });
}

function completed(waited: { status?: string; error?: string }) {
  return waited.status === "error"
    ? waited.error?.trim().toLowerCase() === "completed"
    : ["ok", "completed", "succeeded"].includes(waited.status ?? "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dirname, "..");
  for (const pluginId of ["qa-channel", "qa-lab"]) {
    try {
      await access(path.join(repoRoot, "dist", "extensions", pluginId, "index.js"));
    } catch {
      throw new Error(
        `missing ${pluginId} QA runtime; build with OPENCLAW_BUILD_PRIVATE_QA=1 before running the batch`,
      );
    }
  }
  const preparedBytes = await readFile(args.input);
  const preparedSha256 = createHash("sha256").update(preparedBytes).digest("hex");
  const requests = readRequests(preparedBytes.toString("utf8"));
  const policyBytes = await readFile(args.policyFile);
  const policy = policyBytes.toString("utf8").trim();
  const policySha256 = createHash("sha256").update(policyBytes).digest("hex");
  if (!policy || requests.length === 0) {
    throw new Error("holdout requires a nonempty policy and at least one prepared request");
  }
  const output: string[] = [];
  const gatewayOwner = createQaGatewayChild();
  const lab = await startQaLabServer({ repoRoot, embeddedGateway: "disabled" });
  const transportOwner = await createQaTransportAdapter({
    channelId: "qa-channel",
    driver: "qa-channel",
    outputDir: repoRoot,
    state: lab.state,
  });
  try {
    const gateway = await gatewayOwner.start({
      repoRoot,
      transport: transportOwner.adapter,
      transportBaseUrl: lab.listenUrl,
      providerMode: "live-frontier",
      forcedRuntime: args.runtime,
      primaryModel: args.model,
      alternateModel: args.model,
      controlUiEnabled: false,
    });
    for (const request of requests) {
      const sessionKey = `agent:qa:pati-holdout:${randomUUID()}`;
      const target = `dm:pati-holdout-${randomUUID()}`;
      const delivery = transportOwner.adapter.buildAgentDelivery({ target });
      const inputText = JSON.stringify(request.input);
      const inputSha256 = createHash("sha256").update(inputText).digest("hex");
      const contextReadEvents = request.input.messages
        .filter(
          (message): message is PreparedInput["messages"][number] & { text: string } =>
            typeof message.text === "string",
        )
        .map((message) => ({
          ref: message.ref,
          source: "model_input_context" as const,
          textSha256: createHash("sha256").update(message.text).digest("hex"),
        }));
      const startedAt = Date.now();
      let runId: string | null = null;
      let waited: { status?: string; error?: string } | null = null;
      let reply: string | null = null;
      let history: History | null = null;
      let usage: SessionUsage | null = null;
      let error: string | null = null;
      try {
        const started = (await gateway.call(
          "agent",
          {
            idempotencyKey: randomUUID(),
            agentId: "qa",
            sessionKey,
            message: `${policy}\n\n${inputText}`,
            deliver: true,
            channel: delivery.channel,
            to: delivery.to ?? target,
            replyChannel: delivery.replyChannel,
            replyTo: delivery.replyTo,
          },
          { timeoutMs: 30_000 },
        )) as { runId?: string };
        if (!started.runId) {
          throw new Error("agent did not return runId");
        }
        runId = started.runId;
        waited = (await gateway.call(
          "agent.wait",
          { runId, timeoutMs: args.timeoutMs },
          { timeoutMs: resolveQaGatewayTimeoutWithGraceMs(args.timeoutMs) },
        )) as { status?: string; error?: string };
        const conversationId = target.slice(3);
        for (let poll = 0; poll < 20; poll += 1) {
          reply =
            lab.state
              .getSnapshot()
              .messages.findLast(
                (message) =>
                  message.direction === "outbound" && message.conversation.id === conversationId,
              )?.text ?? null;
          if (reply) {
            break;
          }
          await sleep(250);
        }
        history = (await gateway.call("chat.history", { sessionKey, limit: 200 })) as History;
        usage = (await gateway.call("sessions.usage", {
          key: sessionKey,
          agentId: "qa",
          limit: 1,
        })) as SessionUsage;
      } catch (cause) {
        error = createQaGatewayCliError(cause).message;
      }
      const usageRow = usage?.sessions?.find((row) => row.key === sessionKey);
      const totals = usageRow?.usage;
      const costUsd =
        totals?.missingCostEntries === 0 &&
        typeof totals.totalCost === "number" &&
        Number.isFinite(totals.totalCost)
          ? totals.totalCost
          : null;
      const record = {
        id: request.id,
        mode: args.mode,
        sourceSha: args.sourceSha,
        policySha256,
        preparedSha256,
        inputSha256,
        model: args.model,
        runtime: args.runtime,
        runId,
        completed: Boolean(waited && completed(waited) && reply?.trim()),
        elapsedMs: Date.now() - startedAt,
        costUsd,
        reply,
        readRefs: contextReadEvents.map((event) => event.ref),
        readRefsEvidence: "included_in_model_input",
        contextReadEvents,
        toolReadRefs: null,
        events: history?.messages ?? [],
        usageEvidence: {
          source: "sessions.usage",
          sessionKey,
          totals: totals ?? null,
          cacheStatus: usage?.cacheStatus ?? null,
        },
        waited,
        error,
      };
      output.push(JSON.stringify(record));
      await writeFile(args.output, `${output.join("\n")}\n`);
    }
  } finally {
    await transportOwner.cleanupBeforeGatewayStop();
    const stopped = await gatewayOwner.stop();
    if (stopped.process !== "unconfirmed") {
      await transportOwner.cleanupAfterGatewayStop();
    }
    await lab.stop();
  }
  process.stdout.write(`Pati holdout ${args.mode}: ${output.length} episode receipts\n`);
}

await main();
