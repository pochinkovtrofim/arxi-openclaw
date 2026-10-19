import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticModelCallContent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import {
  addUpstreamRequestIdSpanEvent,
  assignGenAiModelCallAttrs,
  assignModelCallPromptStatsAttrs,
  assignPositiveNumberAttr,
  assignModelCallUsageAttrs,
  genAiOperationName,
  modelCallSpanName,
} from "./service-genai-attributes.js";
import { assignOtelModelContentAttributes } from "./service-genai-content.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { ModelCallLifecycleDiagnosticEvent } from "./service-types.js";

const INFERENCE_TRANSPORT_KINDS = new Set(["http", "websocket", "mixed", "none"]);

/** Content-free relay transport facts: a closed kind and four counts. */
function assignInferenceTransportAttrs(
  attrs: Record<string, string | number | boolean>,
  evt: ModelCallLifecycleDiagnosticEvent,
): void {
  const transport = evt.inferenceTransport;
  if (!transport || !INFERENCE_TRANSPORT_KINDS.has(transport.kind)) {
    return;
  }
  attrs["openclaw.model_call.inference_transport"] = transport.kind;
  for (const [key, value] of [
    ["http_requests", transport.httpRequests],
    ["websocket_requests", transport.webSocketRequests],
    ["upgrade_attempts", transport.upgradeAttempts],
    ["upgrade_refusals", transport.upgradeRefusals],
  ] as const) {
    if (Number.isSafeInteger(value) && value >= 0) {
      attrs[`openclaw.model_call.inference.${key}`] = value;
    }
  }
}

export function createModelRecorders(runtime: DiagnosticsRecorderRuntime) {
  return {
    recordModelCallStarted(
      evt: Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!runtime.tracesEnabled || !metadata.trusted) {
        return undefined;
      }
      const trackedSpan = runtime.getTrackedInternalOrTrustedSpan(evt, metadata);
      if (trackedSpan) {
        return trackedSpan.spanContext();
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.provider": evt.provider,
        "openclaw.model": evt.model,
      };
      runtime.addRunAttrs(spanAttrs, evt);
      assignGenAiModelCallAttrs(spanAttrs, evt);
      if (evt.api) {
        spanAttrs["openclaw.api"] = evt.api;
      }
      if (evt.transport) {
        spanAttrs["openclaw.transport"] = evt.transport;
      }
      assignModelCallPromptStatsAttrs(spanAttrs, evt);
      return runtime
        .trackTrustedSpan(
          evt,
          metadata,
          runtime.spanWithDuration(modelCallSpanName(evt), spanAttrs, undefined, {
            kind: SpanKind.CLIENT,
            parentContext: runtime.activeTrustedParentContext(evt, metadata),
            startTimeMs: evt.ts,
          }),
          "model.call",
        )
        .spanContext();
    },
    recordModelCallFinished(
      evt: ModelCallLifecycleDiagnosticEvent,
      metadata: DiagnosticEventMetadata,
      modelContent?: DiagnosticModelCallContent,
    ) {
      const errorType =
        evt.type === "model.call.error"
          ? normalizeDiagnosticValue(evt.errorCategory, "other")
          : undefined;
      const metricAttrs = {
        "openclaw.provider": evt.provider,
        "openclaw.model": evt.model,
        "openclaw.api": normalizeDiagnosticValue(evt.api),
        "openclaw.transport": normalizeDiagnosticValue(evt.transport),
        "openclaw.model_call.observation_unit": evt.observationUnit ?? "request",
        ...(errorType !== undefined ? { "openclaw.errorCategory": errorType } : {}),
        ...(evt.type === "model.call.error" && evt.failureKind
          ? { "openclaw.failureKind": normalizeDiagnosticValue(evt.failureKind, "other") }
          : {}),
      };
      if (evt.durationMs !== undefined) {
        runtime.modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
      }
      for (const [histogram, value] of [
        [runtime.modelCallRequestBytesHistogram, evt.requestPayloadBytes],
        [runtime.modelCallResponseBytesHistogram, evt.responseStreamBytes],
        [runtime.modelCallTimeToFirstByteHistogram, evt.timeToFirstByteMs],
      ] as const) {
        const normalized = asPositiveFiniteNumber(value);
        if (normalized !== undefined) {
          histogram.record(normalized, metricAttrs);
        }
      }
      if (evt.durationMs !== undefined) {
        runtime.genAiOperationDurationHistogram.record(evt.durationMs / 1000, {
          "gen_ai.operation.name": genAiOperationName(evt.api, evt.observationUnit),
          "gen_ai.provider.name": normalizeDiagnosticValue(evt.provider),
          "gen_ai.request.model": normalizeDiagnosticValue(evt.model),
          ...(errorType ? { "error.type": errorType } : {}),
        });
      }
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.provider": evt.provider,
        "openclaw.model": evt.model,
        ...(errorType !== undefined
          ? { "openclaw.errorCategory": errorType, "error.type": errorType }
          : {}),
      };
      runtime.addRunAttrs(spanAttrs, evt);
      if (evt.type === "model.call.error" && evt.failureKind) {
        spanAttrs["openclaw.failureKind"] = normalizeDiagnosticValue(evt.failureKind, "other");
      }
      assignGenAiModelCallAttrs(spanAttrs, evt);
      if (evt.api) {
        spanAttrs["openclaw.api"] = evt.api;
      }
      if (evt.transport) {
        spanAttrs["openclaw.transport"] = evt.transport;
      }
      for (const [key, value] of [
        ["openclaw.model_call.request_bytes", evt.requestPayloadBytes],
        ["openclaw.model_call.response_bytes", evt.responseStreamBytes],
        ["openclaw.model_call.time_to_first_byte_ms", evt.timeToFirstByteMs],
      ] as const) {
        assignPositiveNumberAttr(spanAttrs, key, value);
      }
      assignInferenceTransportAttrs(spanAttrs, evt);
      assignModelCallPromptStatsAttrs(spanAttrs, evt);
      assignModelCallUsageAttrs(spanAttrs, evt);
      assignOtelModelContentAttributes(spanAttrs, modelContent, runtime.captureContent);
      const trackedSpan = runtime.takeTrackedTrustedSpan(evt, metadata);
      if (!trackedSpan && evt.durationMs === undefined) {
        return;
      }
      const span =
        trackedSpan ??
        runtime.spanWithDuration(modelCallSpanName(evt), spanAttrs, evt.durationMs, {
          kind: SpanKind.CLIENT,
          parentContext: runtime.activeTrustedParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
      runtime.setSpanAttrs(span, spanAttrs);
      addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
      if (evt.type === "model.call.error") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
      }
      if (!trackedSpan) {
        runtime.bindTrustedSpan(evt, metadata, span, "model.call");
      }
      span.end(evt.ts);
    },
  };
}
