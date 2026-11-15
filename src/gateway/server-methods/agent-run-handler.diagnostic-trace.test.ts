import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import {
  markGatewayFrameStep,
  runWithGatewayFrameReceipt,
} from "../server/ws-connection/frame-receipt.js";
import { agentRunHandler } from "./agent-run-handler.js";

const startTurn = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../agent-turn/agent-request-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-turn/agent-request-preflight.js")>()),
  prepareAgentRequestPreflight: () => ({ request: {} }),
}));
vi.mock("../agent-turn/agent-turn-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-turn/agent-turn-service.js")>()),
  createAgentTurnService: () => ({ startTurn }),
}));
vi.mock("../agent-turn/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-turn/io.js")>()),
  createAgentTurnIo: () => ({ emitAcceptance: vi.fn() }),
}));
vi.mock("../agent-turn/principal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-turn/principal.js")>()),
  captureAgentTurnPrincipal: () => null,
  resolveAgentTurnRunObserver: () => undefined,
}));
vi.mock("./validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./validation.js")>()),
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

  it("hands the moment of receipt to the turn", async () => {
    const before = Date.now();
    await agentRunHandler({
      params: {},
      respond: vi.fn(),
      context: {},
      client: null,
      isWebchatConnect: () => false,
    } as never);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcReceivedAt: expect.toSatisfy((at: number) => at >= before && at <= Date.now()),
        receiptSteps: [],
      }),
    );
  });

  it("starts the turn's clock when its frame was read off the socket", async () => {
    const receivedAt = Date.now() - 900;
    await runWithGatewayFrameReceipt(receivedAt, async () => {
      markGatewayFrameStep("frame_admission");
      markGatewayFrameStep("request_authorize");
      await agentRunHandler({
        params: {},
        respond: vi.fn(),
        context: {},
        client: null,
        isWebchatConnect: () => false,
      } as never);
    });
    const { rpcReceivedAt, receiptSteps } = (
      startTurn.mock.calls[0] as unknown as [
        { rpcReceivedAt: number; receiptSteps: Array<{ step: string; at: number }> },
      ]
    )[0];
    expect(rpcReceivedAt).toBe(receivedAt);
    expect(receiptSteps.map(({ step }) => step)).toEqual([
      "frame_admission",
      "request_authorize",
      "handler_entry",
    ]);
    expect(receiptSteps.every(({ at }) => at >= receivedAt && at <= Date.now())).toBe(true);
  });
});
