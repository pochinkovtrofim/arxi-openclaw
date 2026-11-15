import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import {
  markGatewayFrameStep,
  runWithGatewayFrameReceipt,
  takeGatewayFrameReceipt,
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
    const frameReceipt = runWithGatewayFrameReceipt(receivedAt, takeGatewayFrameReceipt);
    markGatewayFrameStep(frameReceipt, "frame_admission");
    markGatewayFrameStep(frameReceipt, "request_authorize");
    await agentRunHandler({
      params: {},
      respond: vi.fn(),
      context: {},
      client: null,
      isWebchatConnect: () => false,
      frameReceipt,
    } as never);
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

  it("gives a request dispatched in-process during a frame its own clock", async () => {
    // A subagent run started from a tool is an in-process request under its parent's
    // frame: it carries no receipt, so its stages start at its own handler.
    const before = Date.now();
    await runWithGatewayFrameReceipt(before - 60_000, () =>
      agentRunHandler({
        params: {},
        respond: vi.fn(),
        context: {},
        client: null,
        isWebchatConnect: () => false,
      } as never),
    );
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcReceivedAt: expect.toSatisfy((at: number) => at >= before),
        receiptSteps: [],
      }),
    );
  });
});
