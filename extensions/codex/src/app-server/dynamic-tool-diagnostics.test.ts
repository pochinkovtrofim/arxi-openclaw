// Codex tests cover the content-free dynamic tool lifecycle diagnostics.
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { describe, expect, it } from "vitest";
import {
  createCodexDynamicToolDiagnostics,
  readThrownDynamicToolErrorCode,
} from "./dynamic-tool-diagnostics.js";

async function captureToolEvents(emit: () => void): Promise<DiagnosticEventPayload[]> {
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type.startsWith("tool.execution.")) {
      events.push(event);
    }
  });
  try {
    emit();
    await waitForDiagnosticEventsDrained();
  } finally {
    unsubscribe();
  }
  return events;
}

const call = (tool: string, args: unknown) => ({
  threadId: "thread-1",
  turnId: "turn-1",
  callId: `call-${tool}`,
  tool,
  arguments: args as never,
});

describe("Codex dynamic tool diagnostics", () => {
  it("labels exec calls with the content-free command class only", async () => {
    const context = { call: call("exec", { command: "/usr/bin/python3 /home/owner/secret.py" }) };
    const diagnostics = createCodexDynamicToolDiagnostics(context);
    const events = await captureToolEvents(() => {
      diagnostics.started();
      diagnostics.terminal({ success: true, contentItems: [] } as never, 12);
    });

    expect(events.map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ toolName: "exec", execClass: "python3" });
      expect(JSON.stringify(event)).not.toContain("secret");
    }
  });

  it("leaves other tools without a command class", async () => {
    const events = await captureToolEvents(() =>
      createCodexDynamicToolDiagnostics({ call: call("read", { command: "ls" }) }).started(),
    );

    expect(events).toHaveLength(1);
    expect(Object.hasOwn(events[0] ?? {}, "execClass")).toBe(false);
  });

  it("records the HTTP status a thrown tool error carries, as the embedded runtime does", async () => {
    const refused = Object.assign(new Error("source unavailable or changed"), { statusCode: 409 });
    expect(readThrownDynamicToolErrorCode(refused)).toBe("409");
    expect(readThrownDynamicToolErrorCode(Object.assign(new Error("x"), { status: 403 }))).toBe("403");
    expect(readThrownDynamicToolErrorCode(Object.assign(new Error("x"), { code: "follow_limit", status: 429 }))).toBe(
      "follow_limit",
    );
    for (const opaque of [new Error("Web fetch failed"), Object.assign(new Error("x"), { status: 999 }), "text"]) {
      expect(readThrownDynamicToolErrorCode(opaque)).toBeUndefined();
    }
    const events = await captureToolEvents(() =>
      createCodexDynamicToolDiagnostics({ call: call("ro_google_observation", {}) }).error(
        19,
        "failed",
        readThrownDynamicToolErrorCode(refused),
      ),
    );
    expect(events[0]).toMatchObject({ type: "tool.execution.error", errorCode: "409" });
  });
});
