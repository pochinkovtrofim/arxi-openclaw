import { describe, expect, it } from "vitest";
import {
  describeAgentRunErrorIdentity,
  errorOrigin,
  normalizeAgentRunErrorIdentity,
} from "./agent-run-error-identity.js";

describe("agent run error identity", () => {
  it("names a thrown error by kind and place, never by its text", () => {
    const error = new TypeError("owner said: call Maria at +34 600 000 000");
    error.stack = [
      "TypeError: owner said: call Maria at +34 600 000 000",
      "    at Array.map (<anonymous>)",
      "    at node:internal/process/task_queues:105:5",
      "    at run (/opt/openclaw/node_modules/undici/lib/fetch.js:10:2)",
      "    at condenseDay (/opt/openclaw/dist/day-memory-abc123.js:812:17)",
    ].join("\n");
    const identity = describeAgentRunErrorIdentity({ error });
    expect(identity).toEqual({ name: "TypeError", origin: "day-memory-abc123.js:812" });
    expect(JSON.stringify(identity)).not.toContain("Maria");
  });

  it("keeps codes, the direct cause and redacted provider facts", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    cause.stack = "Error: socket hang up\n    at file:///opt/openclaw/dist/net.js:5:1";
    const error = new Error("Agent run failed", { cause });
    error.stack = "Error: Agent run failed\n    at attempt (/opt/openclaw/dist/run.js:40:9)";
    expect(
      describeAgentRunErrorIdentity({
        error,
        failoverCode: "provider_unavailable",
        observation: {
          failoverReason: "overloaded",
          providerErrorType: "overloaded_error",
          httpStatus: 529,
          providerErrorMessagePreview: "Overloaded, please retry",
        },
      }),
    ).toEqual({
      name: "Error",
      code: "provider_unavailable",
      origin: "run.js:40",
      causeName: "Error",
      causeCode: "ECONNRESET",
      causeOrigin: "net.js:5",
      failoverReason: "overloaded",
      providerErrorType: "overloaded_error",
      httpStatus: 529,
    });
  });

  it("names a result error by its kind when nothing was thrown", () => {
    expect(
      describeAgentRunErrorIdentity({ error: "free text", kind: "compaction_failure" }),
    ).toEqual({
      kind: "compaction_failure",
    });
    expect(describeAgentRunErrorIdentity({ error: "free text" })).toBeUndefined();
  });

  it("drops anything that is not a bounded token", () => {
    expect(
      normalizeAgentRunErrorIdentity({
        kind: "has spaces in it",
        name: "x".repeat(65),
        code: "E_OK",
        origin: "a.js:1",
        httpStatus: 42,
        extra: "ignored",
      }),
    ).toEqual({ code: "E_OK", origin: "a.js:1" });
    expect(normalizeAgentRunErrorIdentity({ kind: "with\nnewline" })).toBeUndefined();
    expect(normalizeAgentRunErrorIdentity("text")).toBeUndefined();
  });

  it("reads the first frame outside dependencies", () => {
    expect(errorOrigin("E\n    at /x/node_modules/a.js:1:1\n    at C:\\app\\dist\\b.js:7:3")).toBe(
      "b.js:7",
    );
    expect(errorOrigin("E\n    at <anonymous>")).toBeUndefined();
    expect(errorOrigin(undefined)).toBeUndefined();
  });
});
