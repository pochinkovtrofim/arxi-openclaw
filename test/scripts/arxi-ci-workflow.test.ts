import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  jobs?: Record<
    string,
    { steps?: Array<{ name?: string; run?: string; with?: Record<string, unknown> }> }
  >;
};

describe("Arxi fork gate", () => {
  it("checks the upstream pin with bounded candidate ancestry", () => {
    const workflow = parse(readFileSync(".github/workflows/arxi-ci.yml", "utf8")) as Workflow;
    const steps = workflow.jobs?.["runtime-contract"]?.steps ?? [];
    const checkout = steps.find((step) => step.name === "Checkout exact candidate");
    const resolve = steps.find(
      (step) => step.name === "Resolve exact change and qualified upstream bases",
    );

    expect(checkout?.with?.["fetch-depth"]).toBe(1);
    expect(checkout?.with?.filter).toBe("blob:none");
    expect(resolve?.run).toContain(
      'git fetch --no-tags --filter=blob:none --depth=1 origin "$change_base" "$upstream_base"',
    );
    expect(resolve?.run).toContain("history_limit=4096");
    expect(resolve?.run).toContain(
      'git fetch --no-tags --filter=blob:none --deepen="$history_limit" origin "$GITHUB_SHA"',
    );
    expect(resolve?.run).toContain('git merge-base --is-ancestor "$upstream_base" HEAD');
  });

  it("classifies requester-scoped MCP and repository instruction changes", () => {
    const workflow = parse(readFileSync(".github/workflows/arxi-ci.yml", "utf8")) as Workflow;
    const steps = workflow.jobs?.["runtime-contract"]?.steps ?? [];
    const reject = steps.find((step) => step.name === "Reject unclassified production changes");

    expect(reject?.run).toContain("src/agents/mcp-connection-resolver.ts");
    expect(reject?.run).toContain("src/agents/mcp-oauth-identity.ts");
    expect(reject?.run).toContain("src/plugins/types.mcp-connection.ts");
    expect(reject?.run).toContain("scripts/AGENTS.md");
  });
});
