import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import * as cliProcess from "./cli-process.js";
import { createClaudeCliTransport, type ClaudeCliTransport } from "./cli-transport.js";

type ClaudeChild = Awaited<
  ReturnType<ReturnType<typeof cliProcess.createClaudeCliProcessOwner>["spawn"]>
>;

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((shutdown) => shutdown()));
  vi.restoreAllMocks();
});

async function openTransport(): Promise<{
  transport: ClaudeCliTransport;
  written: Record<string, unknown>[];
  answer: (response: Record<string, unknown>) => Promise<void>;
}> {
  const output = createDeferred<void>();
  const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  let onExit: Parameters<ClaudeChild["onExit"]>[0] | undefined;
  let emit: Parameters<ClaudeChild["consumeStdout"]>[0] | undefined;
  const written: Record<string, unknown>[] = [];
  const child: ClaudeChild = {
    supportsRawOutput: true,
    stdin: {
      write: (data, callback) => {
        written.push(JSON.parse(String(data)) as Record<string, unknown>);
        callback?.();
      },
      end: () => {},
    },
    onStdout: () => {},
    onStderr: () => {},
    onError: () => {},
    onExit: (listener) => {
      onExit = listener;
    },
    consumeStdout: (listener) => {
      emit = listener;
      return output.promise;
    },
    wait: () => exit.promise,
    kill: () => {},
    dispose: () => {},
  };
  vi.spyOn(cliProcess, "createClaudeCliProcessOwner").mockReturnValue({
    spawn: async () => child,
    withDiagnostics: async (error: unknown) => error,
    [Symbol.dispose]: () => {},
  });
  const context = { command: "claude", args: [], cwd: ".", env: {} };
  const transport = await createClaudeCliTransport({
    context,
    args: [],
    initialize: {},
    currentContext: () => context,
    onMessage: async () => {},
    onRequest: async () => () => ({}),
    onError: () => {},
  });
  opened.push(async () => {
    transport.close();
    onExit?.(0, null);
    exit.resolve({ code: 0, signal: null });
    output.resolve();
    await transport.waitForExit();
  });
  return {
    transport,
    written,
    answer: async (response) => {
      await emit?.(`${JSON.stringify({ type: "control_response", response })}\n`);
    },
  };
}

it("resolves a skills reload on its own successful response", async () => {
  const { transport, written, answer } = await openTransport();
  const reply = transport.reloadSkills();
  await vi.waitFor(() => expect(written).toHaveLength(1));
  const requestId = written[0]?.request_id;
  expect(written[0]).toMatchObject({
    type: "control_request",
    request: { subtype: "reload_skills" },
  });

  await answer({ subtype: "success", request_id: "another-request", response: { skills: ["x"] } });
  await answer({ subtype: "success", request_id: requestId, response: { skills: [] } });
  await expect(reply).resolves.toBeUndefined();
});

it("rejects a skills reload on an error response without echoing native text", async () => {
  const { transport, written, answer } = await openTransport();
  const reply = transport.reloadSkills();
  await vi.waitFor(() => expect(written).toHaveLength(1));

  await answer({ subtype: "error", request_id: written[0]?.request_id, error: "native detail" });
  await expect(reply).rejects.toThrow("Claude CLI refused the control request.");
});

it("rejects a skills reload that is not answered in time", async () => {
  const { transport } = await openTransport();
  await expect(transport.reloadSkills(20)).rejects.toThrow(
    "did not answer the control request in time",
  );
});

it("rejects a pending skills reload when the transport closes", async () => {
  const { transport, written } = await openTransport();
  const reply = transport.reloadSkills();
  await vi.waitFor(() => expect(written).toHaveLength(1));
  transport.close();
  await expect(reply).rejects.toThrow("control channel is closed");
});
