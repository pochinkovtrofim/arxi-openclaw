import { describe, expect, it } from "vitest";
import { browserFlowToBrowserArgs, BrowserFlowToolSchema } from "./browser-flow-tool.js";
import { createBrowserToolSchema, resolveBrowserToolCapabilities } from "./browser-tool.schema.js";

describe("browser_flow tool", () => {
  it("runs as the browser tool's flow action, with the browser's own tab and profile fields", () => {
    expect(
      browserFlowToBrowserArgs({
        op: "run",
        name: "search",
        params: { query: "lamp" },
        select: ["title"],
        limit: 3,
        targetId: "t1",
        profile: "openclaw",
      }),
    ).toEqual({
      action: "flow_run",
      flow: { name: "search", params: { query: "lamp" }, select: ["title"] },
      limit: 3,
      targetId: "t1",
      profile: "openclaw",
    });
    expect(browserFlowToBrowserArgs({ op: " save ", name: "x" })).toEqual({
      action: "flow_save",
      flow: { name: "x" },
    });
    expect(() => browserFlowToBrowserArgs({ op: "act" })).toThrow(/op must be/);
  });

  it("keeps saved-flow fields out of the browser tool's schema", () => {
    const browser = createBrowserToolSchema(resolveBrowserToolCapabilities());
    expect(JSON.stringify(browser.properties.action)).not.toContain("flow_");
    expect(browser.properties).not.toHaveProperty("flow");
    expect(BrowserFlowToolSchema.properties.op.enum).toEqual(["save", "run", "list", "delete"]);
  });
});
