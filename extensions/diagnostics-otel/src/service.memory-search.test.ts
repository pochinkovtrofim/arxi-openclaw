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
    // Both successful searches share one attribute set per phase, so the SDK
    // aggregates them into one data point each.
    expect(samples).toEqual(
      expect.arrayContaining([
        {
          attributes: { ...okAttrs, "openclaw.memory_search.phase": "total" },
          sum: 1280,
          count: 2,
        },
        {
          attributes: { ...okAttrs, "openclaw.memory_search.phase": "index_read" },
          sum: 30,
          count: 2,
        },
        {
          attributes: { ...okAttrs, "openclaw.memory_search.phase": "embed_query" },
          sum: 900,
          count: 2,
        },
        {
          attributes: { ...okAttrs, "openclaw.memory_search.phase": "sync_wait" },
          sum: 0,
          count: 2,
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
    // Four aggregated ok phases plus the error total; the untrusted copy and the
    // error event's absent phases never become samples.
    expect(samples).toHaveLength(5);

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
      (toolHistogram?.dataPoints ?? []).map(
        (point) => point.attributes["openclaw.memory_search.phase"],
      ),
    ).toEqual(expect.arrayContaining(["embed_query", "search"]));
  } finally {
    try {
      await stopStartedOtelServices();
    } finally {
      await meterProvider.shutdown();
    }
  }
});

test("labels the tool record with the dominant phase, counting the untimed remainder as search", async () => {
  await startOtelService({ traces: true });
  try {
    const calls = [
      // Deadline expiry while the query embedding was still running.
      { id: "deadline-embed", outcome: "unavailable", durationMs: 30_000, embedQueryMs: 29_900 },
      // A short embedding inside a call whose time went to retrieval.
      { id: "slow-retrieval", outcome: "ok", durationMs: 30_000, embedQueryMs: 1_000 },
      // An awaited bootstrap sync.
      { id: "sync-bound", outcome: "partial", durationMs: 30_000, syncWaitMs: 25_000 },
    ] as const;
    for (const call of calls) {
      emitTrustedDiagnosticEvent({
        type: "memory.search.completed",
        toolCallId: call.id,
        provider: "local",
        outcome: call.outcome,
        durationMs: call.durationMs,
        indexReadMs: 10,
        embedQueryMs: "embedQueryMs" in call ? call.embedQueryMs : 0,
        syncWaitMs: "syncWaitMs" in call ? call.syncWaitMs : 0,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        toolName: "memory_search",
        toolSource: "plugin",
        toolCallId: call.id,
        durationMs: call.durationMs,
      });
    }
    // A cooldown answer never reached a manager search: no phase fields, no label.
    emitTrustedDiagnosticEvent({
      type: "memory.search.completed",
      toolCallId: "cooldown",
      provider: "other",
      outcome: "unavailable",
      durationMs: 1,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      toolName: "memory_search",
      toolSource: "plugin",
      toolCallId: "cooldown",
      durationMs: 2,
    });
    await waitForDiagnosticEventsDrained();

    const toolSpans = sdk.exporter
      .getFinishedSpans()
      .filter((span) => span.name === "openclaw.tool.execution");
    expect(toolSpans.map((span) => span.attributes["openclaw.memory_search.phase"])).toEqual([
      "embed_query",
      "search",
      "sync_wait",
      undefined,
    ]);
  } finally {
    await stopStartedOtelServices();
  }
});
