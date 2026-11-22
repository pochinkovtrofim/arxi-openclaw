import { describe, expect, it } from "vitest";
import { ownerPreambleText } from "./owner-preamble-text.js";

describe("ownerPreambleText", () => {
  it("keeps the words and drops reply directives", () => {
    expect(ownerPreambleText("[[reply_to_current]] Let me check your calendar.")).toBe(
      "Let me check your calendar.",
    );
    expect(ownerPreambleText("  On it.  ")).toBe("On it.");
  });

  it("sends nothing for a silent reply, media or an empty text", () => {
    expect(ownerPreambleText("NO_REPLY")).toBeUndefined();
    expect(ownerPreambleText("Here it is\nMEDIA:/tmp/chart.png")).toBeUndefined();
    expect(ownerPreambleText("[[reply_to_current]]")).toBeUndefined();
  });
});
