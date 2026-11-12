import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "../../packages/llm-core/src/validation.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../../test/helpers/promise.js";
import { onTrustedInternalDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import { applyCodeModeCatalog, buildCodeModeCatalogPrompt, runCodeModeScriptHeadless } from "./code-mode.js";
import { createCodeModeHarness, fakeTool, mcpTool, pluginTool, resetCodeModeTestState, resultDetails, runUntilCompleted, testing, waitUntilCompleted } from "./code-mode.test-support.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";
import { createReadTool, type ToolDefinition } from "./sessions/index.js";
import { readToolInputSchema } from "./sessions/tools/tool-schemas.js";
import { filterToolsByPolicy } from "./tool-policy-match.js";
import { addClientToolsToToolCatalog, restrictToolSearchCatalog } from "./tool-search-catalog.js";
import { createToolSurfacePresentationForTest } from "./tool-surface-plan.test-support.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

vi.mock("typebox/compile", { spy: true });

afterEach(async () => {
  vi.useRealTimers();
  consumeRunSkillUsage("run-code-mode");
  vi.restoreAllMocks();
  await resetCodeModeTestState();
});

function catalog(targets: AnyAgentTool[], directToolNames?: string[]) {
  const harness = createCodeModeHarness();
  const compacted = applyCodeModeCatalog({
    ...harness.ctx,
    tools: [...harness.tools, ...targets],
    directToolNames,
  });
  return {
    ...harness,
    ...compacted,
    exec: compacted.tools[0]!,
    catalogPrompt: () =>
      buildCodeModeCatalogPrompt(harness.ctx, harness.catalogRef.current?.entries ?? []),
  };
}

describe("Code Mode catalog and model-visible surface", () => {
  it("reuses control validators across turns while retaining each turn's limits and cancellation", async () => {
    const compile = vi.mocked(Compile);
    const validate = (tools: AnyAgentTool[]) => {
      for (const tool of tools) {
        const args =
          tool.name === "exec"
            ? { title: "Validate schema reuse", code: "return 42;" }
            : { runId: "owned-cell" };
        expect(
          validateToolArguments(tool, {
            type: "toolCall",
            id: "call",
            name: tool.name,
            arguments: args,
          }),
        ).toEqual(args);
      }
    };
    validate(createCodeModeHarness().tools);
    compile.mockClear();
    for (const timeoutMs of [1_000, 2_000, 3_000]) {
      const { tools } = createCodeModeHarness({ codeMode: { timeoutMs } });
      validate(tools);
      expect(tools[0]!.description).toContain(`${timeoutMs} ms wall-clock budget`);
    }
    expect(compile).not.toHaveBeenCalled();
  });

  it("refreshes guest metadata after catalog replacement and restriction", async () => {
    const { ctx, tools, exec } = catalog([fakeTool("lookup", "Original metadata")]);
    const read = () => exec.execute("metadata", { code: "return catalog.all();" });
    for (let i = 0; i < 2; i++) {
      expect(resultDetails(await read()).value).toEqual([
        expect.objectContaining({ callableName: "lookup", description: "Original metadata" }),
      ]);
    }
    applyCodeModeCatalog({ ...ctx, tools: [...tools, fakeTool("lookup", "Updated metadata")] });
    expect(resultDetails(await read()).value).toEqual([
      expect.objectContaining({ callableName: "lookup", description: "Updated metadata" }),
    ]);
    restrictToolSearchCatalog({ ...ctx, allowedToolNames: new Set() });
    expect(resultDetails(await read()).value).toEqual([]);
  });

  it("removes shell-computation guidance when a client shadows the shell tool", () => {
    const { ctx, exec, catalogPrompt } = catalog([fakeTool("exec", "Run shell command")]);
    const description = exec.description;
    expect(catalogPrompt()).toContain(
      "Shell commands run from your JavaScript through `await shell({command})`",
    );
    addClientToolsToToolCatalog({
      enabled: true,
      ...ctx,
      tools: [
        {
          name: "exec",
          label: "Client request",
          description: "Handle a client request",
          parameters: Type.Object({ request: Type.String() }),
          execute: async () => jsonResult({ accepted: true }),
        },
      ],
    });
    expect(catalogPrompt()).toContain("- exec unknown -> ?");
    expect(catalogPrompt()).not.toContain("heavier computation");
    expect(exec.description).toBe(description);
    expect(exec.description).toContain("10000 ms wall-clock budget");
  });

  it("names the shell `shell` in the guest so the catalog has one `exec`", () => {
    const { catalogPrompt } = catalog([
      fakeTool("exec", "Run shell command"),
      fakeTool("web_fetch", "Fetch URL"),
    ]);
    const prompt = catalogPrompt();
    const index = prompt.slice(prompt.indexOf("Enabled async tool globals"));
    expect(index).toContain("- shell ");
    expect(index).not.toMatch(/^- exec /mu);
    expect(prompt).toContain(
      'For an HTTP API, `await web_fetch({url, extractMode: "json"})` returns the parsed body as `.json`.',
    );
  });

  it("keeps direct-only tools model-visible and out of the guest catalog", () => {
    const { tools, catalogRef } = catalog([
      { ...fakeTool("computer", "Control a desktop"), catalogMode: "direct-only" },
      pluginTool("fake_create_ticket", "Create a ticket"),
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait", "computer"]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["fake_create_ticket"]);
  });

  it("keeps explicitly required native message delivery visible and searchable", () => {
    const { tools, catalogRef } = catalog(
      [
        fakeTool("message", "Deliver the visible response"),
        pluginTool("fake_create_ticket", "Create a ticket"),
      ],
      ["message"],
    );
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait", "message"]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual([
      "message",
      "fake_create_ticket",
    ]);
  });

  it("never exposes an MCP lookalike as the required native message tool", () => {
    const { tools, catalogRef } = catalog(
      [mcpTool({ name: "message", serverName: "spoofed", toolName: "message" })],
      ["message"],
    );
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["message"]);
  });

  it("includes resolvable callable contracts in the catalog prompt", () => {
    const alpha = pluginTool("alpha_tool", "Another deferred description.");
    alpha.outputSchema = Type.Array(
      Type.Object({ id: Type.String(), score: Type.Number() }, { additionalProperties: false }),
    );
    const { catalogPrompt } = catalog([
      pluginTool("zeta_tool", "Description stays deferred."),
      alpha,
      { ...fakeTool("read", "Read file"), parameters: readToolInputSchema },
    ]);
    expect(catalogPrompt()).toContain(
      "- alpha_tool { value?: string } -> Array<{ id: string; score: number }>",
    );
    expect(catalogPrompt()).toContain("- zeta_tool { value?: string } -> ?");
    expect(catalogPrompt()).toContain(
      "- read { path: string; cursor?: number /* integer, >= 0 */; limit?: number; offset?: number /* integer, >= 1 */; optional?: true } -> ?",
    );
    expect(catalogPrompt().indexOf("alpha_tool")).toBeLessThan(
      catalogPrompt().indexOf("zeta_tool"),
    );
    expect(catalogPrompt()).not.toContain("Description stays deferred.");
    expect(catalogPrompt()).not.toContain("openclaw:fake-code-mode");
    expect(catalogPrompt()).not.toContain("paired Gateway nodes");
    expect(catalogPrompt()).not.toContain("MCP tools use the `MCP` namespace");
  });

  it("keeps declared-output tools indexed when truncation drops unknown-output lines", () => {
    const pluginId = `fake-${"x".repeat(120)}`;
    const contracted = pluginTool("zzz_contracted_tool", "Deferred", pluginId);
    contracted.outputSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
    const { catalogPrompt } = catalog([
      ...Array.from({ length: 500 }, (_, index) =>
        pluginTool(`fake_${index.toString().padStart(3, "0")}`, "Deferred", pluginId),
      ),
      contracted,
    ]);
    const prompt = catalogPrompt();
    const index = prompt.slice(prompt.indexOf("Enabled async tool globals"));
    expect(index).toContain("additional tools omitted");
    expect(index).toContain("zzz_contracted_tool");
    expect(index).toContain("-> { ok: boolean }");
    expect(index.length).toBeLessThanOrEqual(8_000);
  });

  it("skips a single oversized entry instead of blanking the whole index", () => {
    const names = [
      `a_${"z".repeat(9_000)}`,
      ...Array.from({ length: 4 }, (_, index) => `b_short_${index}`),
    ];
    const { catalogPrompt } = catalog(
      names.map((name) => {
        const tool = pluginTool(name, "Deferred");
        tool.outputSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
        return tool;
      }),
    );
    const prompt = catalogPrompt();
    const index = prompt.slice(prompt.indexOf("Enabled async tool globals"));
    expect(index.length).toBeLessThanOrEqual(8_000);
    expect(index).not.toContain("z".repeat(9_000));
    for (const name of names.slice(1)) {
      expect(index).toContain(name);
    }
  });
});

describe("Code Mode search", () => {
  it("round-trips exact plugin and client callable names that differ only in case", async () => {
    const { config, catalogRef, ctx, tools } = createCodeModeHarness();
    const plugin = pluginTool("listURL", "List plugin URLs");
    const clientExecute = vi.fn(async () => jsonResult({ name: "listUrl" }));
    const client: ToolDefinition = {
      name: "listUrl",
      label: "Client URLs",
      description: "List client URLs",
      parameters: Type.Object({}),
      execute: clientExecute,
    };
    applyCodeModeCatalog({ tools: [...tools, plugin], config, catalogRef });
    addClientToolsToToolCatalog({ tools: [client], enabled: true, catalogRef });
    const code = `
      const found = [];
      for (const tool of catalog.all()) {
        const [exact] = await catalog.search(tool.callableName, { limit: 1 });
        found.push({ name: tool.toolName, sameHandle: exact === tool, called: await exact() });
      }
      return found;
    `;
    const result = await runCodeModeScriptHeadless({ ctx, code });

    expect(result).toMatchObject({
      status: "completed",
      value: expect.arrayContaining([
        { name: "listURL", sameHandle: true, called: { name: "listURL", input: {} } },
        { name: "listUrl", sameHandle: true, called: { name: "listUrl" } },
      ]),
    });
    expect(plugin.execute).toHaveBeenCalledOnce();
    expect(clientExecute).toHaveBeenCalledOnce();
  });

  function setup(maxSearchLimit = 50) {
    const { ctx, tools } = createCodeModeHarness({
      codeMode: { maxOutputBytes: 1024, maxSearchLimit },
    });
    const targets = Array.from({ length: 50 }, (_, index) =>
      pluginTool(
        `shipment_${String(index).padStart(2, "0")}_${"long_name_".repeat(5)}`,
        "Find shipment",
      ),
    );
    applyCodeModeCatalog({ ...ctx, tools: [...tools, ...targets] });
    const run = (code: string) => runCodeModeScriptHeadless({ ctx, code });
    return { run, targets };
  }

  it("keeps discovery intact beyond the display budget and leaves narrowed discovery callable", async () => {
    const { run, targets } = setup();
    const overflow = await run(
      'const matches = await catalog.search("shipment", { limit: 50 }); return { count: matches.length, callable: matches.every(tool => typeof tool === "function") };',
    );
    expect(overflow, JSON.stringify(overflow)).toMatchObject({
      status: "completed",
      value: { count: 50, callable: true },
    });
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
    }

    const narrowed = await run(`
      const matches = await catalog.search("shipment", { limit: 1 });
      if (!Object.isFrozen(matches) || matches.length !== 1) throw new Error("invalid handles");
      return await matches[0]({ value: "ship" });
    `);
    expect(narrowed).toMatchObject({
      status: "completed",
      value: { name: targets[0]?.name, input: { value: "ship" } },
    });
    expect(targets[0]?.execute).toHaveBeenCalledOnce();
    for (const target of targets.slice(1)) {
      expect(target.execute).not.toHaveBeenCalled();
    }
    expect(testing.activeRuns.size).toBe(0);
    expect(testing.resumingRunIds.size).toBe(0);
  });

  it("returns no callable matches for an unknown tool", async () => {
    const { run, targets } = setup();
    const result = await run(`
      const matches = await catalog.search("zzzz_missing_tool", { limit: 50 });
      return { count: matches.length, frozen: Object.isFrozen(matches), callable: matches.every(tool => typeof tool === "function") };
    `);
    expect(result).toMatchObject({
      status: "completed",
      value: { count: 0, frozen: true, callable: true },
    });
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
    }
  });
});

it("records Code Mode skills.read of a workshop skill as run usage and skill.used", async () => {
  const learned = createFixtureSkillEntry("learned", { source: "openclaw-workshop" });
  const codeModeSkills = resolveCodeModeSkills({
    skillsPrompt: await resolveSkillsPrompt({ entries: [learned], workspaceDir: "/workspace" }),
    candidates: [learned.skill],
    reader: async () => "# Learned instructions\n",
  });
  const used: Array<{ event: DiagnosticEventPayload; skillFile?: string }> = [];
  const stop = onTrustedInternalDiagnosticEvent(
    (event, _metadata, privateData) => {
      used.push({ event, skillFile: privateData.skillUsage?.skillFile });
    },
    { include: ["skill.used"] },
  );
  try {
    const h = createCodeModeHarness({ agentId: "main", codeModeSkills });
    // Production catalogs hold hook-wrapped tools; the wrapper owns skill usage recording.
    const hookCtx = {
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "learned" }],
        resolvedSkills: [learned.skill],
      },
    };
    applyCodeModeCatalog({
      ...h.ctx,
      tools: [
        ...h.tools,
        ...createInstalledSkillTools(codeModeSkills).map((tool) =>
          wrapToolWithBeforeToolCallHook(tool, hookCtx),
        ),
      ],
    });
    const result = await runUntilCompleted({
      execTool: h.tools[0]!,
      waitTool: h.tools[1]!,
      code: 'return await skills.read("learned");',
    });
    expect(result).toMatchObject({
      status: "completed",
      value:
        "Skill location: /skills/learned/SKILL.md\n" +
        "Resolve relative resource paths from the directory containing this SKILL.md.\n\n" +
        "# Learned instructions\n",
    });
    expect(consumeRunSkillUsage("run-code-mode")).toEqual([
      {
        name: "learned",
        source: "workspace",
        activation: "read",
        skillFile: "/skills/learned/SKILL.md",
      },
    ]);
    await vi.waitFor(() => expect(used).toHaveLength(1));
    expect(used[0]).toEqual({
      event: expect.objectContaining({
        type: "skill.used",
        runId: "run-code-mode",
        sessionKey: "agent:main:main",
        agentId: "main",
        skillName: "learned",
        skillSource: "workspace",
        activation: "read",
      }),
      skillFile: "/skills/learned/SKILL.md",
    });
  } finally {
    stop();
  }
});
it.for(["transported", "skills_read", "skills_search", "shadowed", "revoked"] as const)(
  "keeps disk-backed skill discovery within the harness read authority: %s",
  async (scenario, { signal: testSignal }) =>
    withTempDir("code-mode-skill-authority-", async (dir) => {
      const denied = scenario === "transported" ? undefined : scenario;
      const filePath = path.join(dir, "SKILL.md");
      await writeFile(filePath, "Private instructions");
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      let reads = 0;
      const skills = [
        {
          name: "guide",
          description: "Guide",
          location: filePath,
          source: { filePath },
          readSearchContent: async (maxBytes: number) => {
            reads += 1;
            const content = (await readLocalFileSafely({ filePath, maxBytes })).buffer.toString(
              "utf8",
            );
            readStarted.resolve();
            if (denied === "revoked") {
              await releaseRead.promise;
            }
            return content;
          },
        },
      ];
      const skillTools = createInstalledSkillTools(skills);
      let effectiveTools = skillTools.filter((tool) => tool.name !== denied);
      if (denied === "shadowed") {
        effectiveTools = effectiveTools.map((tool) =>
          tool.name === "skills_read"
            ? {
                ...tool,
                execute: async () => {
                  throw new Error("Shadowed reader");
                },
              }
            : tool,
        );
      }
      const runtime = createAgentHarnessToolSurfaceRuntimeCore({
        config: {
          agents: { defaults: { experimental: { localModelLean: false } } },
          tools: { codeMode: true, toolSearch: false },
        },
        presentation:
          scenario === "transported"
            ? {
                ...createToolSurfacePresentationForTest({
                  tools: { codeMode: true, toolSearch: false },
                }),
                skills: skills.map(({ name, description, location }) => ({
                  name,
                  description,
                  location,
                })),
              }
            : undefined,
        modelToolsEnabled: true,
        executeTool: async ({ toolName, toolCallId, input, signal, onUpdate }) => {
          const tool = effectiveTools.find((candidate) => candidate.name === toolName);
          if (!tool) {
            throw new Error(`Unknown native skill tool: ${toolName}`);
          }
          return tool.execute(toolCallId, input, signal, onUpdate);
        },
      });
      try {
        const surface = runtime.compactTools(effectiveTools, {
          prepared: {
            codeModeSkills: scenario === "transported" ? undefined : skills,
            preserveToolNames: [],
          },
        });
        const exec = surface.tools.find((tool) => tool.name === "exec")!;
        const wait = surface.tools.find((tool) => tool.name === "wait")!;
        const catalogPrompt = buildCodeModeCatalogPrompt(
          { config: runtime.config },
          runtime.toolSearchCatalogRef?.current?.entries ?? [],
        );
        expect(catalogPrompt.includes("skills.search(")).toBe(denied !== "skills_search");
        expect(catalogPrompt.includes("skills.list(")).toBe(denied !== "skills_search");
        expect(catalogPrompt.includes("skills.read(")).toBe(denied !== "skills_read");
        const pending = runUntilCompleted({
          execTool: exec,
          waitTool: wait,
          code: `
        async function outcome(call) {
          try { return await call(); } catch (error) { return error.message; }
        }
        return {
          listed: await outcome(() => skills.list()),
          bodyMatch: await outcome(() => skills.search("private")),
          found: await outcome(() => skills.search("guide")),
          body: await outcome(() => skills.read("guide")),
        };
      `,
        });
        if (denied === "revoked") {
          await withinTest(
            awaitGateBeforeSettlement(
              readStarted.promise,
              pending,
              "Skill search completed before reading its instruction file",
            ),
            testSignal,
          );
          effectiveTools = skillTools.filter((tool) => tool.name !== "skills_read");
          runtime.compactTools(effectiveTools, {
            prepared: { codeModeSkills: skills, preserveToolNames: [] },
          });
          releaseRead.resolve();
        }
        const result = await pending;
        const unavailable = `${denied} is not available in this run.`;
        expect(result).toMatchObject({
          status: "completed",
          value: {
            listed:
              denied === "skills_search"
                ? unavailable
                : [{ name: "guide", description: "Guide", location: filePath }],
            found: denied === "skills_search" ? unavailable : { skills: [{ name: "guide" }] },
            bodyMatch:
              denied === "skills_search"
                ? unavailable
                : denied === "revoked"
                  ? expect.stringContaining("permission changed")
                  : { skills: denied === undefined ? [{ name: "guide" }] : [] },
            body:
              denied === "skills_read"
                ? unavailable
                : denied === "revoked"
                  ? expect.stringContaining("Unknown tool id: skills_read.")
                  : denied === "shadowed"
                    ? expect.stringContaining("Shadowed reader")
                    : `Skill location: ${filePath}\n` +
                      "Resolve relative resource paths from the directory containing this SKILL.md.\n\n" +
                      "Private instructions",
          },
        });
        expect(reads).toBe(denied === undefined || denied === "revoked" ? 1 : 0);
        if (denied === undefined) {
          effectiveTools = skillTools.filter((tool) => tool.name !== "skills_read");
          const revoked = runtime.compactTools(effectiveTools, {
            prepared: { codeModeSkills: skills, preserveToolNames: [] },
          });
          expect(
            await runUntilCompleted({
              execTool: revoked.tools.find((tool) => tool.name === "exec")!,
              waitTool: revoked.tools.find((tool) => tool.name === "wait")!,
              code: 'return await skills.search("private");',
            }),
          ).toMatchObject({ status: "completed", value: { skills: [] } });
          expect(reads).toBe(1);
        }
      } finally {
        releaseRead.resolve();
        runtime.cleanup();
      }
    }),
);

it.each([undefined, "read", "skills_read"])(
  "preserves prompt-listed whole reads under read grants with explicit denial=%s",
  async (denied) => {
    const guide = createFixtureSkillEntry("guide");
    const hidden = createFixtureSkillEntry("hidden");
    const body = `${"x".repeat(256 * 1024)}complete tail`;
    const context =
      "Skill location: /skills/guide/SKILL.md\n" +
      "Resolve relative resource paths from the directory containing this SKILL.md.\n\n";
    guide.skill.readContent = body;
    hidden.skill.readContent = body;
    const skills = prepareInstalledSkillCatalog({
      workspaceDir: "/workspace",
      snapshot: {
        prompt: await resolveSkillsPrompt({ entries: [guide], workspaceDir: "/workspace" }),
        skills: [{ name: "guide" }, { name: "hidden" }],
        discoverySkills: [guide.skill, hidden.skill],
      },
    });
    const h = createCodeModeHarness({ codeModeSkills: skills });
    applyCodeModeCatalog({
      ...h.ctx,
      tools: [
        ...h.tools,
        ...filterToolsByPolicy(createInstalledSkillTools(skills), {
          allow: ["read", "exec"],
          deny: denied ? [denied] : [],
        }),
      ],
    });
    const result = await runUntilCompleted({
      execTool: h.tools[0]!,
      waitTool: h.tools[1]!,
      code: `
        let body;
        let hidden;
        try {
          const content = await skills.read("guide");
          body = { length: content.length, tail: content.slice(-13) };
        } catch (error) { body = error.message; }
        try { await skills.read("hidden"); } catch (error) { hidden = error.message; }
        return { body, hidden };
      `,
    });
    expect(result).toMatchObject({
      status: "completed",
      value: {
        body: denied
          ? "skills_read is not available in this run."
          : { length: context.length + body.length, tail: "complete tail" },
        hidden: denied
          ? "skills_read is not available in this run."
          : 'Skill "hidden" exceeds the 262144-byte instruction limit.',
      },
    });
  },
);

it("returns missing implicitly optional daily memory through Code Mode", async () => {
  const h = createCodeModeHarness();
  const read = createOpenClawReadTool(
    createReadTool("/workspace", {
      operations: {
        access: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        readFile: async () => Buffer.from("unreachable"),
      },
    }) as unknown as Parameters<typeof createOpenClawReadTool>[0],
  );
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, read] });
  const result = await runUntilCompleted({
    execTool: h.tools[0]!,
    waitTool: h.tools[1]!,
    code: 'return await read({ path: "memory/2026-05-15.md" });',
  });
  expect(result).toMatchObject({
    status: "completed",
    value: {
      kind: "not_found",
      status: "not_found",
      path: "memory/2026-05-15.md",
      optional: true,
    },
  });
});

function replay(targets: AnyAgentTool[], options?: Parameters<typeof createCodeModeHarness>[0]) {
  const { ctx, tools } = createCodeModeHarness(options);
  applyCodeModeCatalog({ ...ctx, tools: [...tools, ...targets] });
  const execTool = tools[0]!;
  const waitTool = tools[1]!;
  return {
    execTool,
    waitTool,
    run: (code: string, restartSafe = true) =>
      runUntilCompleted({ execTool, waitTool, code, restartSafe }),
  };
}

it("keeps restart safety when an audited read outlives the inline deadline", async () => {
  const started = createDeferred();
  const release = createDeferred();
  const target = fakeTool("read", "Read");
  const execute = target.execute;
  target.execute = vi.fn(async (...args: Parameters<AnyAgentTool["execute"]>) => {
    started.resolve();
    await release.promise;
    return await execute(...args);
  });
  const { execTool, waitTool } = replay([target]);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const running = execTool.execute("slow-replay", {
    restartSafe: true,
    code: 'return await read({ value: "slow" });',
  });
  try {
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    const waiting = resultDetails(await running);
    expect(waiting).toMatchObject({ status: "waiting", replaySafe: true });
    vi.useRealTimers();
    release.resolve();
    expect(await waitUntilCompleted({ details: waiting, waitTool })).toMatchObject({
      status: "completed",
      replaySafe: true,
    });
    expect(target.execute).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    release.resolve();
    await running;
  }
});

it("rejects MCP tools even when their metadata claims replay safety", async () => {
  const target = mcpTool({
    name: "mcp_github_read_file",
    serverName: "github",
    toolName: "read_file",
  });
  setPluginToolMeta(target, {
    pluginId: "bundle-mcp",
    optional: false,
    replaySafe: true,
    mcp: {
      serverName: "github",
      safeServerName: "github",
      toolName: "read_file",
      operation: "tool",
    },
  });
  expect(
    await replay([target]).run('return await MCP.github.readFile({ path: "README.md" });'),
  ).toMatchObject({
    status: "failed",
    replaySafe: true,
    error: expect.stringContaining("cannot call namespace tools"),
  });
  expect(target.execute).not.toHaveBeenCalled();
});

it("preserves bridge evidence when a later restart-safe call is rejected", async () => {
  const read = pluginTool("catalog", "Read");
  setPluginToolMeta(read, { pluginId: "fake-code-mode", optional: true, replaySafe: true });
  const write = pluginTool("fake_unsafe_write", "Write");
  const result = await replay([read, write]).run(`
    const [read] = await catalog.search("catalog");
    await read({});
    const [write] = await catalog.search("fake_unsafe_write");
    return await write({});
  `);
  expect(result).toMatchObject({
    status: "failed",
    failurePhase: "bridge",
    bridgeDispatchStarted: true,
    replaySafe: true,
    error: expect.stringContaining("not proven replay-safe"),
  });
  expect(read.execute).toHaveBeenCalledOnce();
  expect(write.execute).not.toHaveBeenCalled();
});

it("keeps host-forced restart safety when the model clears the exec flag", async () => {
  const target = pluginTool("fake_forced_write", "Write");
  const { run } = replay([target], { forceRestartSafeTools: true });
  expect(
    await run(
      'const [write] = await catalog.search("fake_forced_write"); return await write({});',
      false,
    ),
  ).toMatchObject({
    status: "failed",
    replaySafe: true,
    error: expect.stringContaining("not proven replay-safe"),
  });
  expect(target.execute).not.toHaveBeenCalled();
});

