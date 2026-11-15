import { afterEach, expect, it, vi } from "vitest";
import { createPreflightStepRecorder } from "./preflight-step-recorder.js";

afterEach(() => {
  vi.useRealTimers();
});

it("keeps only the last moment of a step recorded again, in order of those moments", () => {
  vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
  const recorder = createPreflightStepRecorder();
  recorder.record("session_patch_build");
  vi.advanceTimersByTime(10);
  recorder.record("session_store_commit");
  vi.advanceTimersByTime(10);
  recorder.record("session_patch_build");
  expect(recorder.steps).toEqual([
    { step: "session_store_commit", at: 1_010 },
    { step: "session_patch_build", at: 1_020 },
  ]);
});
