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
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

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
type PreparedContext = {
  id: string;
  appendSystemContext: string;
  appendContext: string;
  hookStatus: string;
  readEvents: Array<{
    ref: string;
    source: string;
    textSha256: string;
    readKind: string;
  }>;
};
type SessionUsage = {
  sessions?: Array<{
    key?: string;
    usage?: { totalCost?: number; totalTokens?: number; missingCostEntries?: number } | null;
  }>;
  cacheStatus?: unknown;
};
type History = { messages?: Array<Record<string, unknown>> };

function historyUsageEvidence(history: History | null) {
  const assistant = history?.messages?.filter((message) => message.role === "assistant") ?? [];
  const usage = assistant.map((message) => message.usage);
  const complete =
    assistant.length > 0 &&
    usage.every((value) => {
      if (!value || typeof value !== "object") {
        return false;
      }
      const row = value as { totalTokens?: unknown; cost?: { total?: unknown } };
      return (
        typeof row.totalTokens === "number" &&
        Number.isFinite(row.totalTokens) &&
        row.totalTokens > 0 &&
        typeof row.cost?.total === "number" &&
        Number.isFinite(row.cost.total) &&
        row.cost.total >= 0
      );
    });
  return {
    assistantCount: assistant.length,
    coveredAssistantCount: complete ? assistant.length : 0,
    providerReportedCostUsd: complete
      ? usage.reduce((sum, value) => sum + (value as { cost: { total: number } }).cost.total, 0)
      : null,
    reportedTokens: complete
      ? usage.reduce((sum, value) => sum + (value as { totalTokens: number }).totalTokens, 0)
      : null,
  };
}

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
  const codexHome = runtime === "codex" ? required("--codex-home") : undefined;
  if (codexHome && !path.isAbsolute(codexHome)) {
    throw new Error("--codex-home must be an absolute isolated directory");
  }
  return {
    input: required("--input"),
    output: required("--output"),
    policyFile: required("--policy-file"),
    contextFile: options.get("--context-file"),
    taskFile: options.get("--task-file"),
    opsSourceSha: options.get("--ops-source-sha"),
    sourceSha,
    runtime: runtime as "codex" | "openclaw",
    codexHome,
    mode,
    model: options.get("--model") ?? "openai/gpt-5.6-luna",
    timeoutMs,
  };
}

function readContexts(jsonl: string, requests: Request[]): Map<string, PreparedContext> {
  const byId = new Map<string, PreparedContext>();
  const expected = new Map(requests.map((request) => [request.id, request]));
  for (const [index, line] of jsonl
    .split(/\r?\n/u)
    .filter((value) => value.trim())
    .entries()) {
    const value: unknown = JSON.parse(line);
    const row = value as PreparedContext;
    const request = expected.get(row?.id);
    if (
      !request ||
      byId.has(row.id) ||
      typeof row.appendSystemContext !== "string" ||
      typeof row.appendContext !== "string" ||
      !row.appendContext ||
      typeof row.hookStatus !== "string" ||
      !Array.isArray(row.readEvents)
    ) {
      throw new Error(`invalid prepared context at line ${index + 1}`);
    }
    const visible = new Map(
      request.input.messages
        .filter(
          (message): message is PreparedInput["messages"][number] & { text: string } =>
            typeof message.text === "string",
        )
        .map((message) => [message.ref, message]),
    );
    if (
      row.appendContext.includes(request.id) ||
      row.appendSystemContext.includes(request.id) ||
      Object.values(request.sourceIds ?? {}).some(
        (sourceId) =>
          typeof sourceId === "string" &&
          (row.appendContext.includes(sourceId) || row.appendSystemContext.includes(sourceId)),
      ) ||
      row.readEvents.some((event) => {
        const message = visible.get(event?.ref);
        return (
          !message ||
          event.source !== message.source ||
          event.textSha256 !== createHash("sha256").update(message.text).digest("hex") ||
          typeof event.readKind !== "string" ||
          !event.readKind
        );
      })
    ) {
      throw new Error(
        `prepared context leaks identity or has unverified reads at line ${index + 1}`,
      );
    }
    byId.set(row.id, row);
  }
  if (byId.size !== expected.size) {
    throw new Error("prepared contexts must cover exactly the requested episodes");
  }
  return byId;
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
  if (args.codexHome) {
    await access(path.join(args.codexHome, "auth.json"));
  }
  const preparedBytes = await readFile(args.input);
  const preparedSha256 = createHash("sha256").update(preparedBytes).digest("hex");
  const requests = readRequests(preparedBytes.toString("utf8"));
  const policyBytes = await readFile(args.policyFile);
  const policy = policyBytes.toString("utf8").trim();
  const policySha256 = createHash("sha256").update(policyBytes).digest("hex");
  if (
    Boolean(args.contextFile) !== Boolean(args.taskFile) ||
    Boolean(args.contextFile) !== Boolean(args.opsSourceSha)
  ) {
    throw new Error("dynamic replay requires --context-file, --task-file, and --ops-source-sha");
  }
  if (args.opsSourceSha && !/^[0-9a-f]{40}$/u.test(args.opsSourceSha)) {
    throw new Error("--ops-source-sha must be a full Git SHA");
  }
  const contextBytes = args.contextFile ? await readFile(args.contextFile) : null;
  const contexts = contextBytes ? readContexts(contextBytes.toString("utf8"), requests) : null;
  const taskBytes = args.taskFile ? await readFile(args.taskFile) : null;
  const task = taskBytes?.toString("utf8").trim();
  if (taskBytes && !task) {
    throw new Error("dynamic replay requires a nonempty task instruction");
  }
  const contextSha256 = contextBytes
    ? createHash("sha256").update(contextBytes).digest("hex")
    : null;
  const taskSha256 = taskBytes ? createHash("sha256").update(taskBytes).digest("hex") : null;
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
      ...(args.codexHome
        ? {
            // QA points the native user-home scope at a disposable credential copy.
            // Agent scope would start with an empty home despite CODEX_HOME preflight.
            runtimeEnvPatch: { CODEX_HOME: args.codexHome },
            mutateConfig: (cfg: OpenClawConfig) => ({
              ...cfg,
              plugins: {
                ...cfg.plugins,
                entries: {
                  ...cfg.plugins?.entries,
                  codex: {
                    enabled: true,
                    config: { appServer: { homeScope: "user", sandbox: "workspace-write" } },
                  },
                },
              },
            }),
          }
        : {}),
      primaryModel: args.model,
      alternateModel: args.model,
      controlUiEnabled: false,
    });
    for (const request of requests) {
      const sessionKey = `agent:qa:pati-holdout:${randomUUID()}`;
      const target = `dm:pati-holdout-${randomUUID()}`;
      const delivery = transportOwner.adapter.buildAgentDelivery({ target });
      const preparedContext = contexts?.get(request.id);
      const inputText = preparedContext
        ? `${policy}\n\n${preparedContext.appendSystemContext}\n\n${preparedContext.appendContext}\n\n${task}`
        : `${policy}\n\n${JSON.stringify(request.input)}`;
      const inputSha256 = createHash("sha256").update(inputText).digest("hex");
      const contextReadEvents = preparedContext
        ? preparedContext.readEvents
        : request.input.messages
            .filter(
              (message): message is PreparedInput["messages"][number] & { text: string } =>
                typeof message.text === "string",
            )
            .map((message) => ({
              ref: message.ref,
              source: message.source ?? "unknown",
              textSha256: createHash("sha256").update(message.text).digest("hex"),
              readKind: "model_input_context",
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
            message: inputText,
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
      const sessionCostUsd =
        totals?.missingCostEntries === 0 &&
        typeof totals.totalCost === "number" &&
        Number.isFinite(totals.totalCost)
          ? totals.totalCost
          : null;
      const assistantUsage = historyUsageEvidence(history);
      const costUsd = sessionCostUsd ?? assistantUsage.providerReportedCostUsd;
      const costBasis =
        sessionCostUsd !== null
          ? "sessions_usage_provider_reported"
          : assistantUsage.providerReportedCostUsd !== null
            ? "assistant_history_provider_reported"
            : "unavailable";
      const record = {
        id: request.id,
        mode: args.mode,
        sourceSha: args.sourceSha,
        opsSourceSha: args.opsSourceSha ?? null,
        policySha256,
        contextSha256,
        taskSha256,
        hookStatus: preparedContext?.hookStatus ?? null,
        preparedSha256,
        inputSha256,
        model: args.model,
        runtime: args.runtime,
        runId,
        completed: Boolean(waited && completed(waited) && reply?.trim()),
        elapsedMs: Date.now() - startedAt,
        costUsd,
        costBasis,
        reply,
        readRefs: contextReadEvents.map((event) => event.ref),
        readRefsEvidence: preparedContext
          ? "native_hook_prepared_context"
          : "included_in_model_input",
        contextReadEvents,
        toolReadRefs: null,
        events: history?.messages ?? [],
        usageEvidence: {
          source: "sessions.usage",
          sessionKey,
          totals: totals ?? null,
          cacheStatus: usage?.cacheStatus ?? null,
          assistantUsage,
          billingBasis: "provider_reported_subscription_metadata_not_billed_spend",
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
