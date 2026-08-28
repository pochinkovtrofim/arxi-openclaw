import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { agentRunHandler } from "./agent-run-handler.js";

const startTurn = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: () => ({ request: {} }),
}));
vi.mock("../agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn }),
}));
vi.mock("../agent-turn/io.js", () => ({
  createAgentTurnIo: () => ({ emitAcceptance: vi.fn() }),
}));
vi.mock("../agent-turn/principal.js", () => ({
  captureAgentTurnPrincipal: () => null,
  resolveAgentTurnRunObserver: () => undefined,
}));
vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

describe("agentRunHandler diagnostic trace ownership", () => {
  beforeEach(() => {
    startTurn.mockClear();
  });

  it("captures the authenticated request trace before async turn preparation", async () => {
    const requestTrace: DiagnosticTraceContext = {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: "01",
    };

    await runWithDiagnosticTraceContext(requestTrace, () =>
      agentRunHandler({
        params: {},
        respond: vi.fn(),
        context: {},
        client: null,
        isWebchatConnect: () => false,
      } as never),
    );

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ diagnosticTrace: requestTrace }),
    );
  });
});
