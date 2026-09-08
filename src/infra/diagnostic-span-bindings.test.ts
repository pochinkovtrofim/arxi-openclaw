import { afterEach, describe, expect, it } from "vitest";
import {
  createTrustedDiagnosticSpanBindingEmitter,
  onDiagnosticSpanBinding,
  resetDiagnosticSpanBindingsForTest,
  type DiagnosticSpanBindingEvent,
} from "./diagnostic-span-bindings.js";

const diagnostic = {
  traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  spanId: "bbbbbbbbbbbbbbbb",
};
const span = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};

describe("diagnostic span bindings", () => {
  afterEach(() => resetDiagnosticSpanBindingsForTest());

  it("publishes only canonical exporter bindings in one monotonic epoch", () => {
    const events: DiagnosticSpanBindingEvent[] = [];
    const stop = onDiagnosticSpanBinding((event) => events.push(event));
    const emitter = createTrustedDiagnosticSpanBindingEmitter();
    emitter.emit({ diagnostic, span, family: "model.call" });
    emitter.retire();
    stop();

    expect(events[0]).toEqual({ kind: "reset", epoch: null, sequence: 0, reason: "subscribed" });
    expect(events[1]).toMatchObject({ kind: "reset", sequence: 1, reason: "exporter_started" });
    expect(events[1]?.epoch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(events[2]).toEqual({
      kind: "binding",
      epoch: events[1]?.epoch,
      sequence: 2,
      binding: { diagnostic, span, family: "model.call" },
    });
    expect(events[3]).toEqual({ kind: "retired", epoch: events[1]?.epoch, sequence: 3 });
  });

  it("drops invalid IDs and stops an emitter after retirement", () => {
    const events: DiagnosticSpanBindingEvent[] = [];
    onDiagnosticSpanBinding((event) => events.push(event));
    const emitter = createTrustedDiagnosticSpanBindingEmitter();
    emitter.emit({ diagnostic: { ...diagnostic, spanId: "invalid" }, span, family: "model.call" });
    emitter.retire();
    emitter.emit({ diagnostic, span, family: "model.call" });

    expect(events.map((event) => event.kind)).toEqual(["reset", "reset", "retired"]);
  });

  it("rotates and replays active exact mappings for a late subscriber", () => {
    const emitter = createTrustedDiagnosticSpanBindingEmitter();
    emitter.emit({ diagnostic, span, family: "model.call" });
    const events: DiagnosticSpanBindingEvent[] = [];
    onDiagnosticSpanBinding((event) => events.push(event));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "reset", sequence: 1, reason: "subscribed" });
    expect(events[1]).toEqual({
      kind: "binding",
      epoch: events[0]?.epoch,
      sequence: 2,
      binding: { diagnostic, span, family: "model.call" },
    });
  });

  it("does not reset an established subscriber when another channel subscribes", () => {
    const first: DiagnosticSpanBindingEvent[] = [];
    onDiagnosticSpanBinding((event) => first.push(event));
    const emitter = createTrustedDiagnosticSpanBindingEmitter();
    emitter.emit({ diagnostic, span, family: "model.call" });
    const firstEpoch = first.at(-1)?.epoch;
    const second: DiagnosticSpanBindingEvent[] = [];
    onDiagnosticSpanBinding((event) => second.push(event));
    emitter.emit({
      diagnostic: { ...diagnostic, spanId: "cccccccccccccccc" },
      span,
      family: "model.call",
    });

    expect(first.at(-1)).toMatchObject({ epoch: firstEpoch, sequence: 3, kind: "binding" });
    expect(second).toHaveLength(3);
    expect(second[0]).toMatchObject({ kind: "reset", sequence: 1, reason: "subscribed" });
    expect(second[2]).toMatchObject({ kind: "binding", sequence: 3 });
  });

  it("isolates a hostile subscriber from downstream metadata-only consumers", () => {
    const received: DiagnosticSpanBindingEvent[] = [];
    onDiagnosticSpanBinding((event) => {
      if (event.kind === "binding") {
        (event.binding.diagnostic as { traceId: string }).traceId = "f".repeat(32);
      }
      throw new Error("subscriber failure");
    });
    onDiagnosticSpanBinding((event) => received.push(event));
    const emitter = createTrustedDiagnosticSpanBindingEmitter();
    emitter.emit({ diagnostic, span, family: "model.call" });

    expect(received.at(-1)).toEqual(
      expect.objectContaining({ binding: { diagnostic, span, family: "model.call" } }),
    );
  });
});
