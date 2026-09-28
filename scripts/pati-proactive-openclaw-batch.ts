/** One isolated QA gateway for a prepared Pati frozen holdout JSONL batch. */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
type GoogleToolSource = {
  ref: string;
  connectionId: string;
  generation: number;
  source: "gmail" | "calendar";
  resourceId: string;
  revision: string;
  sourceKind: "message" | "event";
  bootstrap: boolean;
  coverageMode: string;
  text: string;
};
type BusinessToolSource = {
  ref: string;
  connectionId: string;
  chatId: number;
  messageId: number;
  updateId: number;
  direction: string;
  receivedAt: string;
  text: string;
};
type ToolFixture = {
  id: string;
  google: GoogleToolSource[];
  business: BusinessToolSource[];
};
type ToolReadEvent = {
  sessionKey: string;
  tool: "arxi_google_observation" | "arxi_business_context";
  ref: string;
  textSha256: string;
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
  // A Codex commentary stream fallback is a projection of the same turn, not
  // another provider call. It can carry zero usage before the terminal record.
  const assistant =
    history?.messages?.filter(
      (message) => message.role === "assistant" && !message.openclawStreamFallback,
    ) ?? [];
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
  const validated = usage as Array<{ cost: { total: number }; totalTokens: number }>;
  return {
    assistantCount: assistant.length,
    coveredAssistantCount: complete ? assistant.length : 0,
    providerReportedCostUsd: complete
      ? validated.reduce((sum, value) => sum + value.cost.total, 0)
      : null,
    reportedTokens: complete ? validated.reduce((sum, value) => sum + value.totalTokens, 0) : null,
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
  const toolFile = options.get("--tool-file");
  if (toolFile && runtime !== "codex") {
    throw new Error("--tool-file requires the isolated Codex QA runtime");
  }
  return {
    input: required("--input"),
    output: required("--output"),
    policyFile: required("--policy-file"),
    contextFile: options.get("--context-file"),
    toolFile,
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

function readToolFixtures(jsonl: string, requests: Request[]): Map<string, ToolFixture> {
  const expected = new Map(requests.map((request) => [request.id, request]));
  const fixtures = new Map<string, ToolFixture>();
  for (const [index, line] of jsonl
    .split(/\r?\n/u)
    .filter((value) => value.trim())
    .entries()) {
    const row = JSON.parse(line) as ToolFixture;
    const request = expected.get(row?.id);
    if (
      !request ||
      fixtures.has(row.id) ||
      !Array.isArray(row.google) ||
      !Array.isArray(row.business)
    ) {
      throw new Error(`invalid tool fixture at line ${index + 1}`);
    }
    const messages = new Map(request.input.messages.map((message) => [message.ref, message]));
    const allowed = (item: { ref: string; text: string }, source: string) => {
      const message = messages.get(item?.ref);
      return (
        message?.source === source &&
        typeof item.text === "string" &&
        item.text === message.text &&
        message.unavailable !== true &&
        !request.input.revokedRefs.includes(item.ref) &&
        request.input.authorizedSources.includes(source) &&
        !item.text.includes(request.id) &&
        !Object.values(request.sourceIds ?? {}).some(
          (sourceId) => typeof sourceId === "string" && item.text.includes(sourceId),
        )
      );
    };
    if (
      row.google.some(
        (item) =>
          !allowed(item, item.source) ||
          !["gmail", "calendar"].includes(item.source) ||
          !item.connectionId ||
          !Number.isSafeInteger(item.generation) ||
          item.generation < 1 ||
          !item.resourceId ||
          !item.revision ||
          !["message", "event"].includes(item.sourceKind) ||
          typeof item.bootstrap !== "boolean" ||
          item.bootstrap ||
          !item.coverageMode,
      ) ||
      row.business.some(
        (item) =>
          !allowed(item, "telegram_business") ||
          !item.connectionId ||
          !Number.isSafeInteger(item.chatId) ||
          item.chatId < 1 ||
          !Number.isSafeInteger(item.messageId) ||
          item.messageId < 1 ||
          !Number.isSafeInteger(item.updateId) ||
          item.updateId < 1 ||
          !item.receivedAt,
      )
    ) {
      throw new Error(`tool fixture contains an unauthorized or stale source at line ${index + 1}`);
    }
    fixtures.set(row.id, row);
  }
  if (fixtures.size !== expected.size) {
    throw new Error("tool fixtures must cover exactly the requested episodes");
  }
  return fixtures;
}

function readToolEvents(
  jsonl: string,
  sessionKey: string,
  fixture: ToolFixture,
  knownSessionKeys: Set<string>,
): ToolReadEvent[] {
  const sources = new Map(
    [...fixture.google, ...fixture.business].map((source) => [source.ref, source]),
  );
  const events: ToolReadEvent[] = [];
  for (const line of jsonl.split(/\r?\n/u).filter((value) => value.trim())) {
    const event = JSON.parse(line) as ToolReadEvent;
    if (!knownSessionKeys.has(event?.sessionKey)) {
      throw new Error("QA read event belongs to an unknown session");
    }
    if (event.sessionKey !== sessionKey) {
      continue;
    }
    const source = sources.get(event.ref);
    if (
      !source ||
      event.tool !==
        (fixture.google.some((item) => item.ref === event.ref)
          ? "arxi_google_observation"
          : "arxi_business_context") ||
      event.textSha256 !== createHash("sha256").update(source.text).digest("hex")
    ) {
      throw new Error("QA read event does not match an authorized exact source");
    }
    events.push(event);
  }
  return events;
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
  const toolBytes = args.toolFile ? await readFile(args.toolFile) : null;
  const toolFixtures = toolBytes ? readToolFixtures(toolBytes.toString("utf8"), requests) : null;
  const toolFixtureSha256 = toolBytes ? createHash("sha256").update(toolBytes).digest("hex") : null;
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
  if (toolFixtures && !contexts) {
    throw new Error("QA source tools require a bounded prepared context");
  }
  const sessions = new Map(
    requests.map((request) => [request.id, `agent:qa:pati-holdout:${randomUUID()}`]),
  );
  const knownSessionKeys = new Set(sessions.values());
  const fixtureDir = toolFixtures ? await mkdtemp(path.join(os.tmpdir(), "pati-qa-read-")) : null;
  const fixturePath = fixtureDir ? path.join(fixtureDir, "sources.json") : null;
  const eventsPath = fixtureDir ? path.join(fixtureDir, "read-events.jsonl") : null;
  if (fixturePath && eventsPath && toolFixtures) {
    const bySession = Object.fromEntries(
      requests.map((request) => {
        const sessionKey = sessions.get(request.id);
        const fixture = toolFixtures.get(request.id);
        if (!sessionKey || !fixture) {
          throw new Error("missing QA source session");
        }
        return [sessionKey, { google: fixture.google, business: fixture.business }];
      }),
    );
    await writeFile(fixturePath, JSON.stringify({ sessions: bySession }), { mode: 0o600 });
    await writeFile(eventsPath, "", { mode: 0o600 });
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
      ...(toolFixtures ? { enabledPluginIds: ["pati-holdout-read-fixture"] } : {}),
      ...(args.codexHome
        ? {
            // QA points the native user-home scope at a disposable credential copy.
            // Agent scope would start with an empty home despite CODEX_HOME preflight.
            runtimeEnvPatch: {
              CODEX_HOME: args.codexHome,
              ...(fixturePath && eventsPath
                ? {
                    PATI_QA_READ_FIXTURE_PATH: fixturePath,
                    PATI_QA_READ_EVENTS_PATH: eventsPath,
                  }
                : {}),
            },
            mutateConfig: (cfg: OpenClawConfig) => ({
              ...cfg,
              ...(fixturePath
                ? {
                    tools: {
                      ...cfg.tools,
                      // The QA coding profile only lists core tools. Grant these
                      // two read-only fixture tools without widening the profile.
                      alsoAllow: [
                        ...new Set([
                          ...(cfg.tools?.alsoAllow ?? []),
                          "arxi_google_observation",
                          "arxi_business_context",
                        ]),
                      ],
                    },
                  }
                : {}),
              plugins: {
                ...cfg.plugins,
                ...(fixturePath ? { enabled: true } : {}),
                ...(fixturePath
                  ? {
                      allow: [
                        ...new Set([...(cfg.plugins?.allow ?? []), "pati-holdout-read-fixture"]),
                      ],
                      load: {
                        ...cfg.plugins?.load,
                        paths: [
                          ...new Set([
                            ...(cfg.plugins?.load?.paths ?? []),
                            path.join(
                              repoRoot,
                              "extensions/qa-lab/test-fixtures/pati-holdout-read-plugin",
                            ),
                          ]),
                        ],
                      },
                    }
                  : {}),
                entries: {
                  ...cfg.plugins?.entries,
                  codex: {
                    enabled: true,
                    config: { appServer: { homeScope: "user", sandbox: "workspace-write" } },
                  },
                  ...(fixturePath ? { "pati-holdout-read-fixture": { enabled: true } } : {}),
                },
              },
            }),
          }
        : {}),
      primaryModel: args.model,
      alternateModel: args.model,
      controlUiEnabled: false,
    });
    let qaPluginState: string | null = null;
    let qaPluginProbeError: string | null = null;
    if (toolFixtures) {
      try {
        const listed = (await gateway.call("plugins.list", {})) as {
          plugins?: Array<{ id: string; runtime?: { state?: string } }>;
        };
        qaPluginState =
          listed.plugins?.find((plugin) => plugin.id === "pati-holdout-read-fixture")?.runtime
            ?.state ?? "absent";
      } catch (cause) {
        qaPluginProbeError = createQaGatewayCliError(cause).message;
      }
    }
    for (const request of requests) {
      const sessionKey = sessions.get(request.id);
      if (!sessionKey) {
        throw new Error("missing QA session key");
      }
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
      let qaEffectiveToolIds: string[] | null = null;
      let qaToolProbeError: string | null = null;
      if (toolFixtures) {
        try {
          const inventory = (await gateway.call("tools.effective", {
            sessionKey,
            agentId: "qa",
          })) as { groups?: Array<{ tools?: Array<{ id?: string }> }> };
          qaEffectiveToolIds =
            inventory.groups
              ?.flatMap((group) => group.tools ?? [])
              .map((tool) => tool.id)
              .filter(
                (id): id is string =>
                  id === "arxi_google_observation" || id === "arxi_business_context",
              ) ?? [];
        } catch (cause) {
          qaToolProbeError = createQaGatewayCliError(cause).message;
        }
      }
      const toolReadEvents =
        eventsPath && toolFixtures
          ? readToolEvents(
              await readFile(eventsPath, "utf8"),
              sessionKey,
              toolFixtures.get(request.id)!,
              knownSessionKeys,
            )
          : null;
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
        toolFixtureSha256,
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
        toolReadRefs: toolReadEvents?.map((event) => event.ref) ?? null,
        toolReadEvents,
        qaToolAvailability: toolFixtures
          ? {
              pluginState: qaPluginState,
              pluginProbeError: qaPluginProbeError,
              effectiveToolIds: qaEffectiveToolIds,
              toolProbeError: qaToolProbeError,
            }
          : null,
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
      await writeFile(args.output, `${output.join("\n")}\n`, { mode: 0o600 });
    }
  } finally {
    await transportOwner.cleanupBeforeGatewayStop();
    const stopped = await gatewayOwner.stop();
    if (stopped.process !== "unconfirmed") {
      await transportOwner.cleanupAfterGatewayStop();
    }
    await lab.stop();
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }
  process.stdout.write(`Pati holdout ${args.mode}: ${output.length} episode receipts\n`);
}

await main();
