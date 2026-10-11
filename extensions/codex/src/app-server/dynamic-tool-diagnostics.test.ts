// Codex tests cover the content-free dynamic tool lifecycle diagnostics.
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { describe, expect, it } from "vitest";
import {
  emitDynamicToolStartedDiagnostic,
  emitDynamicToolTerminalDiagnostic,
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
    const events = await captureToolEvents(() => {
      emitDynamicToolStartedDiagnostic(context);
      emitDynamicToolTerminalDiagnostic({
        ...context,
        durationMs: 12,
        response: { success: true, contentItems: [] } as never,
      });
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
      emitDynamicToolStartedDiagnostic({ call: call("read", { command: "ls" }) }),
    );

    expect(events).toHaveLength(1);
    expect(Object.hasOwn(events[0] ?? {}, "execClass")).toBe(false);
  });
});
