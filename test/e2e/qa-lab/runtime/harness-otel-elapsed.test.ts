import {
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  onTrustedInternalDiagnosticEvent,
  registerDiagnosticTracePropagationBridge,
  runWithDiagnosticTraceContext,
} from "openclaw/plugin-sdk/plugin-test-runtime";
// Verifies the exported OTLP span against the harness producer clock contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginServiceContext } from "../../../../extensions/diagnostics-otel/api.js";
import { createDiagnosticsOtelService } from "../../../../extensions/diagnostics-otel/src/service.js";
import {
  runAgentHarnessLifecycleAttempt,
  runAgentHarnessLifecycleFinalization,
} from "../../../../src/agents/harness/lifecycle.js";
import {
  captureDiagnosticEvents,
  createAttemptParams,
  createAttemptResult,
  createDiagnosticTrace,
  createFinalAssistant,
  createFinalizationParams,
} from "../../../../src/agents/harness/lifecycle.test-support.js";
import type { AgentHarness } from "../../../../src/agents/harness/types.js";
import { startLocalOtlpReceiver } from "./otel-test-support.js";

describe("AgentHarness lifecycle OTLP export", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it.each([
    ...[-3_600_000, 3_600_000].flatMap((wallStep) =>
      ["attempt", "finalization"].flatMap((phase) =>
        [false, true].flatMap((failed) =>
          [false, true].map((missingStart) => ({
            wallStep,
            phase,
            failed,
            missingStart,
            delta: 250,
            expectedElapsed: 250 as number | undefined,
            variant: "ordinary",
          })),
        ),
      ),
    ),
    ...[
      { delta: 0, expectedElapsed: 0 },
      { delta: 0.9, expectedElapsed: 0 },
      { delta: -1, expectedElapsed: undefined },
      { delta: Number.NaN, expectedElapsed: undefined },
      { delta: Number.POSITIVE_INFINITY, expectedElapsed: undefined },
      { delta: 86_400_001, expectedElapsed: undefined },
    ].map((clock) => ({
      delta: clock.delta,
      expectedElapsed: clock.expectedElapsed,
      wallStep: -3_600_000,
      phase: "attempt",
      failed: false,
      missingStart: false,
      variant: "ordinary",
    })),
    ...["classified-error", "empty-finalization"].map((variant) => ({
      variant,
      wallStep: -3_600_000,
      phase: variant === "classified-error" ? "attempt" : "finalization",
      failed: false,
      missingStart: false,
      delta: 250,
      expectedElapsed: 250,
    })),
  ])(
    "exports producer elapsed ($wallStep/$phase/error=$failed/missingStart=$missingStart/delta=$delta/$variant)",
    async ({ wallStep, phase, failed, missingStart, delta, expectedElapsed, variant }) => {
      const receiver = startLocalOtlpReceiver();
      const port = await receiver.listen();
      const service = createDiagnosticsOtelService();
      const ctx: OpenClawPluginServiceContext = {
        config: {
          diagnostics: {
            enabled: true,
            otel: {
              enabled: true,
              endpoint: `http://127.0.0.1:${port}`,
              protocol: "http/protobuf",
              traces: true,
              metrics: false,
              logs: false,
            },
          },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        stateDir: "/tmp/harness-elapsed-test",
        internalDiagnostics: {
          emit: emitTrustedDiagnosticEventWithPrivateData,
          onEvent: (listener) =>
            onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
              if (missingStart && event.type === "harness.run.started") {
                return;
              }
              // Delivery delay belongs to the consumer, not the producer interval.
              if (event.type === "harness.run.completed" || event.type === "harness.run.error") {
                wall += 9000;
                monotonic += 9000;
              }
              listener(event, metadata, privateData);
            }),
          registerTracePropagationBridge: registerDiagnosticTracePropagationBridge,
        },
      };
      const diagnostics = captureDiagnosticEvents();
      let wall = 1_788_696_000_000;
      let monotonic = 100;
      const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wall);
      const processClock = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const execute = () => {
        wall += wallStep + 250;
        monotonic += delta;
        if (failed) {
          throw new Error("synthetic failure");
        }
      };
      const harness: AgentHarness = {
        id: "openclaw",
        label: "Synthetic harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          execute();
          return variant === "classified-error"
            ? {
                ...createAttemptResult(),
                terminal: {
                  kind: "failed",
                  error: new Error("classified failure"),
                  source: "prompt",
                },
              }
            : createAttemptResult();
        },
      };
      try {
        await service.start(ctx);
        const run = runWithDiagnosticTraceContext(createDiagnosticTrace(), () =>
          phase === "attempt"
            ? runAgentHarnessLifecycleAttempt(harness, createAttemptParams())
            : runAgentHarnessLifecycleFinalization(
                harness,
                createFinalizationParams(),
                async () => {
                  execute();
                  return {
                    assistant:
                      variant === "empty-finalization"
                        ? { ...createFinalAssistant(), content: [] }
                        : createFinalAssistant(),
                  };
                },
              ),
        );
        if (failed) {
          await expect(run).rejects.toThrow("synthetic failure");
        } else {
          await run;
        }
        await waitForDiagnosticEventsDrained();
        wallClock.mockRestore();
        processClock.mockRestore();
        await service.stop?.(ctx);
        expect(
          receiver.capturedRequests.some(
            (request) => request.signal === "traces" && request.status === 200,
          ),
        ).toBe(true);
        if (variant === "classified-error") {
          expect(diagnostics.events.at(-1)?.event).toMatchObject({
            type: "harness.run.completed",
            outcome: "error",
          });
        }
        expect(diagnostics.events.at(-1)?.event).toMatchObject({
          timing: {
            clock: "process-monotonic",
            ...(expectedElapsed !== undefined ? { elapsedMs: expectedElapsed } : {}),
            startedAtUnixMs: 1_788_696_000_000,
            endedAtUnixMs: 1_788_696_000_000 + wallStep + 250,
          },
        });
        const terminal = diagnostics.events.at(-1)?.event;
        if (terminal?.type !== "harness.run.completed" && terminal?.type !== "harness.run.error") {
          throw new Error("missing harness terminal");
        }
        expect(terminal.timing?.elapsedMs).toBe(expectedElapsed);
        if (expectedElapsed === undefined) {
          expect(terminal.timing).not.toHaveProperty("elapsedMs");
        }
        const spans = receiver.capturedSpans.filter((span) => span.name === "openclaw.harness.run");
        expect(spans).toHaveLength(1);
        expect(spans[0]?.attributes).toMatchObject({
          "openclaw.harness.timing.clock": "process-monotonic",
          ...(expectedElapsed !== undefined
            ? { "openclaw.harness.timing.elapsed_ms": expectedElapsed }
            : {}),
          "openclaw.harness.timing.started_at_unix_ms": 1_788_696_000_000,
          "openclaw.harness.timing.ended_at_unix_ms": 1_788_696_000_000 + wallStep + 250,
        });
        expect(spans[0]?.attributes["openclaw.harness.timing.elapsed_ms"]).toBe(expectedElapsed);
      } finally {
        wallClock.mockRestore();
        processClock.mockRestore();
        diagnostics.unsubscribe();
        await service.stop?.(ctx);
        await receiver.close();
      }
    },
  );
});
