import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it } from "vitest";
import {
  buildCodexWorkspaceBootstrapContext,
  restoreCodexMandatoryPersonalBootstrap,
} from "./attempt-context.js";
import {
  createCodexPersonalPreEgressGate,
  type CodexPersonalContextReceipt,
} from "./personal-context-gate.js";

it("requires one current short AGENTS carrier beside the real immutable bootstrap snapshot", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pc41-short-agents-"));
  try {
    await fs.writeFile(
      path.join(workspace, "AGENTS.md"),
      "Never disclose the synthetic appointment to another person.",
    );
    const context = await buildCodexWorkspaceBootstrapContext({
      params: {
        sessionId: "short-agents",
        sessionKey: "agent:main:short-agents",
        pluginHarnessToolPolicyRestricted: true,
        config: { agents: { defaults: { workspace } } },
      } as EmbeddedRunAttemptParamsV2,
      resolvedWorkspace: workspace,
      executionWorkspace: workspace,
      effectiveWorkspace: workspace,
      sessionKey: "agent:main:short-agents",
      sessionAgentId: "main",
      memoryToolNames: [],
      ringZeroActive: false,
    });
    const frozen = context.threadDeveloperInstructions;
    expect(frozen).toContain("Never disclose");
    expect(restoreCodexMandatoryPersonalBootstrap(context)).toEqual({ status: "complete" });
    expect(context.threadDeveloperInstructions).toBe(frozen);
    const current = context.turnScopedDeveloperInstructions!;
    const nativeBase = `Native code-owned policy.\n\n${frozen}`;
    const hook = "\n\nSynthetic trusted Owner source guidance.";
    const prompt = "[Pati packet] synthetic trusted Owner context";
    const file = context.turnScopedDeveloperInstructionFiles!.find(
      (v) => path.basename(v.path) === "AGENTS.md",
    )!;
    const segment = `### ${file.path}\n\n${file.content}\n\n`;
    const instructions = nativeBase + hook + "\n\n" + current;
    expect(instructions.split(segment)).toHaveLength(3);
    const receipts: CodexPersonalContextReceipt[] = [];
    const makeGate = () =>
      createCodexPersonalPreEgressGate({
        promptText: prompt,
        packetText: prompt,
        developerInstructions: nativeBase + hook,
        developerBaseInstructions: nativeBase,
        legacySegments: [],
        mandatoryInstructionSegments: [{ name: "AGENTS.md", text: segment }],
        totalContextTokenBudget: 80000,
        onReceipt: (value) => receipts.push(value),
      });
    const body = { instructions, input: [{ role: "user", content: prompt }] };
    const gate = makeGate();
    expect(() => gate(body)).not.toThrow();
    expect(receipts.at(-1)?.status).toBe("within_bound");
    expect(() =>
      gate({ previous_response_id: "native-previous", instructions, input: [] }),
    ).not.toThrow();
    expect(() => gate(body)).not.toThrow(); // Native full-history retry.
    // Incremental physical bodies may omit the older frozen snapshot, never the current one.
    expect(() =>
      gate({ previous_response_id: "native-previous", instructions: current, input: [] }),
    ).not.toThrow();
    for (const candidate of [
      nativeBase + hook + "\n\n",
      nativeBase + hook + "\n\n" + current.replace("Never disclose", "Changed rule"),
      instructions + "\n\n" + segment,
    ]) {
      expect(() => makeGate()({ ...body, instructions: candidate })).toThrow("needs_expansion");
      expect(receipts.at(-1)).toMatchObject({
        status: "needs_expansion",
        reason: "mandatory_source_omitted",
      });
    }
    expect(() => makeGate()({ ...body, instructions: instructions + "\n\n" + nativeBase })).toThrow(
      "needs_expansion",
    );
    expect(receipts.at(-1)?.reason).toBe("source_attribution_changed");
    expect(context.threadDeveloperInstructions).toBe(frozen);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
