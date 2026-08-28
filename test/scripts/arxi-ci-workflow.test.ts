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
});
