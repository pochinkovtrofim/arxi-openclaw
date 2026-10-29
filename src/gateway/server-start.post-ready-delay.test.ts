import { describe, expect, it } from "vitest";
import { resolvePostReadyWorkStartDelayMs } from "./server-start.js";

describe("Gateway post-ready work delay", () => {
  it("keeps the default without a valid override", () => {
    expect(resolvePostReadyWorkStartDelayMs({})).toBe(500);
    for (const value of ["", "0", "-5", "1.5", "soon"]) {
      expect(
        resolvePostReadyWorkStartDelayMs({ OPENCLAW_GATEWAY_POST_READY_WORK_DELAY_MS: value }),
      ).toBe(500);
    }
  });

  it("uses a host override up to one minute", () => {
    expect(
      resolvePostReadyWorkStartDelayMs({ OPENCLAW_GATEWAY_POST_READY_WORK_DELAY_MS: " 8000 " }),
    ).toBe(8000);
    expect(
      resolvePostReadyWorkStartDelayMs({ OPENCLAW_GATEWAY_POST_READY_WORK_DELAY_MS: "600000" }),
    ).toBe(60_000);
  });
});
