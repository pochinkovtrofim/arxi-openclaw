import { randomUUID } from "node:crypto";
import { isValidDiagnosticSpanId, isValidDiagnosticTraceId } from "./diagnostic-trace-context.js";

export type DiagnosticSpanBindingFamily = "harness.run" | "run" | "model.call" | "tool.execution";
export type DiagnosticSpanBindingIdentity = Readonly<{ traceId: string; spanId: string }>;
export type DiagnosticSpanBinding = Readonly<{
  diagnostic: DiagnosticSpanBindingIdentity;
  span: DiagnosticSpanBindingIdentity & Readonly<{ traceFlags: number }>;
  family: DiagnosticSpanBindingFamily;
}>;
export type DiagnosticSpanBindingEvent =
  | Readonly<{ kind: "reset"; epoch: null; sequence: 0; reason: "subscribed" }>
  | Readonly<{
      kind: "reset";
      epoch: string;
      sequence: number;
      reason: "subscribed" | "exporter_started";
    }>
  | Readonly<{ kind: "binding"; epoch: string; sequence: number; binding: DiagnosticSpanBinding }>
  | Readonly<{ kind: "gap"; epoch: string; sequence: number; reason: "overflow" }>
  | Readonly<{ kind: "retired"; epoch: string; sequence: number }>;
export type DiagnosticSpanBindingListener = (event: DiagnosticSpanBindingEvent) => void;
export type DiagnosticSpanBindingEmitter = Readonly<{
  emit: (binding: DiagnosticSpanBinding) => void;
  retire: () => void;
}>;

type BindingSubscription = { epoch?: string; sequence: number };
type ActiveBindingEmitter = { bindings: Map<string, DiagnosticSpanBinding> };
type BindingState = {
  listeners: Map<DiagnosticSpanBindingListener, BindingSubscription>;
  active?: ActiveBindingEmitter;
};

const MAX_ACTIVE_BINDINGS = 1024;
const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;
let state: BindingState = createBindingState();

function createBindingState(): BindingState {
  return { listeners: new Map() };
}

function eventForListener(event: DiagnosticSpanBindingEvent): DiagnosticSpanBindingEvent {
  if (event.kind !== "binding") {
    return Object.freeze({ ...event });
  }
  return Object.freeze({
    ...event,
    binding: Object.freeze({
      ...event.binding,
      diagnostic: Object.freeze({ ...event.binding.diagnostic }),
      span: Object.freeze({ ...event.binding.span }),
    }),
  });
}

function publish(listener: DiagnosticSpanBindingListener, event: DiagnosticSpanBindingEvent): void {
  try {
    listener(eventForListener(event));
  } catch {
    // A telemetry consumer cannot interrupt the canonical exporter.
  }
}

function validBinding(binding: DiagnosticSpanBinding): boolean {
  return (
    isValidDiagnosticTraceId(binding.diagnostic.traceId) &&
    isValidDiagnosticSpanId(binding.diagnostic.spanId) &&
    isValidDiagnosticTraceId(binding.span.traceId) &&
    isValidDiagnosticSpanId(binding.span.spanId) &&
    Number.isInteger(binding.span.traceFlags) &&
    binding.span.traceFlags >= 0 &&
    binding.span.traceFlags <= 255 &&
    (binding.family === "harness.run" ||
      binding.family === "run" ||
      binding.family === "model.call" ||
      binding.family === "tool.execution")
  );
}

function bindingKey(binding: DiagnosticSpanBinding): string {
  return `${binding.diagnostic.traceId}:${binding.diagnostic.spanId}`;
}

function resetSubscription(
  listener: DiagnosticSpanBindingListener,
  subscription: BindingSubscription,
  active: ActiveBindingEmitter,
  reason: "subscribed" | "exporter_started",
): void {
  subscription.epoch = randomUUID();
  subscription.sequence = 1;
  publish(listener, { kind: "reset", epoch: subscription.epoch, sequence: 1, reason });
  for (const binding of active.bindings.values()) {
    subscription.sequence += 1;
    publish(listener, {
      kind: "binding",
      epoch: subscription.epoch,
      sequence: subscription.sequence,
      binding,
    });
  }
}

function resetAllSubscriptions(active: ActiveBindingEmitter): void {
  for (const [listener, subscription] of state.listeners) {
    resetSubscription(listener, subscription, active, "exporter_started");
  }
}

function publishBinding(binding: DiagnosticSpanBinding): void {
  for (const [listener, subscription] of state.listeners) {
    if (!subscription.epoch) {
      continue;
    }
    subscription.sequence += 1;
    publish(listener, {
      kind: "binding",
      epoch: subscription.epoch,
      sequence: subscription.sequence,
      binding,
    });
  }
}

function retireAllSubscriptions(): void {
  for (const [listener, subscription] of state.listeners) {
    if (!subscription.epoch) {
      continue;
    }
    subscription.sequence += 1;
    publish(listener, {
      kind: "retired",
      epoch: subscription.epoch,
      sequence: subscription.sequence,
    });
  }
}

function restartAfterOverflow(active: ActiveBindingEmitter): void {
  for (const [listener, subscription] of state.listeners) {
    if (!subscription.epoch || subscription.sequence >= MAX_SAFE_SEQUENCE) {
      continue;
    }
    subscription.sequence += 1;
    publish(listener, {
      kind: "gap",
      epoch: subscription.epoch,
      sequence: subscription.sequence,
      reason: "overflow",
    });
  }
  active.bindings.clear();
  resetAllSubscriptions(active);
}

/** Subscribes to metadata-only canonical diagnostic-to-OTel span bindings. */
export function onDiagnosticSpanBinding(listener: DiagnosticSpanBindingListener): () => void {
  const subscription: BindingSubscription = { sequence: 0 };
  state.listeners.set(listener, subscription);
  if (state.active) {
    // This stream is subscriber-local, so a late owner channel cannot reset or
    // tombstone mappings already accepted by another channel.
    resetSubscription(listener, subscription, state.active, "subscribed");
  } else {
    publish(listener, { kind: "reset", epoch: null, sequence: 0, reason: "subscribed" });
  }
  return () => state.listeners.delete(listener);
}

/** Core-only issuer, injected through the trusted diagnostics-otel service capability. */
export function createTrustedDiagnosticSpanBindingEmitter(): DiagnosticSpanBindingEmitter {
  if (state.active) {
    retireAllSubscriptions();
  }
  const active: ActiveBindingEmitter = { bindings: new Map() };
  state.active = active;
  resetAllSubscriptions(active);
  let retired = false;
  return {
    emit(binding) {
      if (retired || state.active !== active || !validBinding(binding)) {
        return;
      }
      const key = bindingKey(binding);
      if (
        !active.bindings.has(key) &&
        (active.bindings.size >= MAX_ACTIVE_BINDINGS ||
          [...state.listeners.values()].some(
            (subscription) => subscription.sequence >= MAX_SAFE_SEQUENCE - 1,
          ))
      ) {
        restartAfterOverflow(active);
      }
      const canonical: DiagnosticSpanBinding = {
        diagnostic: { ...binding.diagnostic },
        span: { ...binding.span },
        family: binding.family,
      };
      active.bindings.set(key, canonical);
      publishBinding(canonical);
    },
    retire() {
      if (retired || state.active !== active) {
        return;
      }
      retired = true;
      state.active = undefined;
      retireAllSubscriptions();
    },
  };
}

export function resetDiagnosticSpanBindingsForTest(): void {
  state = createBindingState();
}
