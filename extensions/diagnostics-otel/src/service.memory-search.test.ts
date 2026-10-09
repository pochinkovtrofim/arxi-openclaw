// Real SDK aggregation proves memory_search phase timing exports stay trusted-only and content-free.
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();

test("exports memory_search phase timing as a histogram and span from trusted events only", async () => {
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter });
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(meterProvider);
  await startOtelService({ traces: true, metrics: true });
  try {
    emitTrustedDiagnosticEvent({
      type: "memory.search.completed",
      toolCallId: "call-slow",
      provider: "local",
      outcome: "ok",
      durationMs: 1200,
      indexReadMs: 30,
      embedQueryMs: 900,
      syncWaitMs: 0,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      toolName: "memory_search",
      toolSource: "plugin",
      toolCallId: "call-slow",
      durationMs: 1250,
    });
    emitTrustedDiagnosticEvent({
      type: "memory.search.completed",
      toolCallId: "call-keyword",
      provider: "local",
      outcome: "ok",
      durationMs: 80,
      indexReadMs: 0,
      embedQueryMs: 0,
      syncWaitMs: 0,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      toolName: "memory_search",
      toolSource: "plugin",
      toolCallId: "call-keyword",
      durationMs: 90,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      toolName: "memory_search",
      toolSource: "plugin",
      toolCallId: "call-unobserved",
      durationMs: 70,
    });
    emitTrustedDiagnosticEvent({
      type: "memory.search.completed",
      provider: "agent:main:private",
      outcome: "error",
      durationMs: 40,
    });
    emitDiagnosticEvent({
      type: "memory.search.completed",
      provider: "local",
      outcome: "ok",
      durationMs: 5,
      embedQueryMs: 5,
    });
    await waitForDiagnosticEventsDrained();

    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    const histogram = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "openclaw.memory_search.duration_ms");
    const samples = (histogram?.dataPoints ?? []).map((point) => ({
      attributes: point.attributes,
      sum: (point.value as { sum?: number }).sum,
      count: (point.value as { count?: number }).count,
    }));
    const okAttrs = {
      "openclaw.memory_search.provider": "local",
      "openclaw.memory_search.outcome": "ok",
    };
    expect(samples).toEqual(
      expect.arrayContaining([
        {
          attributes: { ...okAttrs, "openclaw.memory_search.phase": "total" },
          sum: 1200,
          count: 1,
        },
        {
          attributes: { ...okAttrs, "openclaw.memory_search.phase": "index_read" },
          sum: 30,
          count: 1,
        },
        {
          attributes: { ...okAttrs, "openclaw.memory_search.phase": "embed_query" },
          sum: 900,
          count: 1,
        },
        {
          attributes: { ...okAttrs, "openclaw.memory_search.phase": "sync_wait" },
          sum: 0,
          count: 1,
        },
        {
          attributes: {
            "openclaw.memory_search.provider": "other",
            "openclaw.memory_search.outcome": "error",
            "openclaw.memory_search.phase": "total",
          },
          sum: 40,
          count: 1,
        },
      ]),
    );
    // Two full searches (4 phases each), one error (total only); the untrusted
    // copy and the error event's absent phases never become samples.
    expect(samples).toHaveLength(9);

    const spans = sdk.exporter
      .getFinishedSpans()
      .filter((span) => span.name === "openclaw.memory_search");
    expect(spans).toHaveLength(3);
    const ok = spans.find((span) => span.attributes["openclaw.memory_search.outcome"] === "ok");
    expect(ok?.attributes).toEqual({
      ...okAttrs,
      "openclaw.memory_search.index_read_ms": 30,
      "openclaw.memory_search.embed_query_ms": 900,
      "openclaw.memory_search.sync_wait_ms": 0,
    });
    const failed = spans.find(
      (span) => span.attributes["openclaw.memory_search.outcome"] === "error",
    );
    expect(failed?.attributes["openclaw.memory_search.provider"]).toBe("other");
    expect(failed?.attributes).not.toHaveProperty("openclaw.memory_search.embed_query_ms");

    // The tool.execution span of the same call carries the dominant phase as a
    // bounded label, which is what the host receiver keeps.
    const toolSpans = sdk.exporter
      .getFinishedSpans()
      .filter((span) => span.name === "openclaw.tool.execution");
    expect(toolSpans.map((span) => span.attributes["openclaw.memory_search.phase"])).toEqual([
      "embed_query",
      "search",
      undefined,
    ]);
    const toolHistogram = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "openclaw.tool.execution.duration_ms");
    expect(
      (toolHistogram?.dataPoints ?? []).map((point) => point.attributes["openclaw.memory_search.phase"]),
    ).toEqual(expect.arrayContaining(["embed_query", "search"]));
  } finally {
    try {
      await stopStartedOtelServices();
    } finally {
      await meterProvider.shutdown();
    }
  }
});
