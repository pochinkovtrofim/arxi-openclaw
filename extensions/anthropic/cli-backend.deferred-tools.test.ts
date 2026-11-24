import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

function resolve(deferredTools: unknown) {
  return buildAnthropicCliBackend().resolveDeferredMcpTools?.({
    config: { plugins: { entries: { anthropic: { config: { deferredTools } } } } },
    agentId: "main",
  });
}

describe("Claude CLI deferred OpenClaw tools", () => {
  it("defers nothing unless the operator names tools", () => {
    expect(buildAnthropicCliBackend().resolveDeferredMcpTools?.({ agentId: "main" })).toEqual([]);
    expect(resolve(undefined)).toEqual([]);
    expect(resolve("sessions_spawn")).toEqual([]);
  });

  it("passes the operator's names and prefixes through", () => {
    expect(resolve(["sessions_spawn", "google_workspace__google_artifact_*"])).toEqual([
      "sessions_spawn",
      "google_workspace__google_artifact_*",
    ]);
  });

  it("accepts a list of names in the plugin config and refuses anything else", () => {
    const check = (deferredTools: unknown) =>
      validateJsonSchemaValue({
        schema: manifest.configSchema,
        value: { deferredTools },
      }).ok;
    expect(check(["sessions_spawn", "theme"])).toBe(true);
    expect(check([""])).toBe(false);
    expect(check("sessions_spawn")).toBe(false);
  });
});
