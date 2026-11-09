import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createWebFetchTool } from "../../agents/tools/web-fetch.js";
import { SKILL_AUTHORING_STANDARDS_PROMPT } from "./skill-authoring-standards.js";

describe("skill authoring standards", () => {
  it("point JSON API steps at a web_fetch mode the tool accepts", () => {
    expect(SKILL_AUTHORING_STANDARDS_PROMPT).toContain('web_fetch extractMode "json"');
    const tool = createWebFetchTool({ config: {}, sandboxed: false });
    expect(tool?.parameters).toBeDefined();
    const args = { url: "https://api.example.com/items" };
    expect(Value.Check(tool!.parameters, { ...args, extractMode: "json" })).toBe(true);
    expect(Value.Check(tool!.parameters, { ...args, extractMode: "jsonl" })).toBe(false);
  });
});
