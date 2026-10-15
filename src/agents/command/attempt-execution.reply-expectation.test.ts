import { describe, expect, it } from "vitest";
import { resolveCommandReplyExpectation } from "./attempt-execution.helpers.js";

describe("resolveCommandReplyExpectation", () => {
  const direct = {
    cfg: {},
    sessionKey: "agent:main:external:direct",
    runContext: { chatType: "direct" as const },
    messageChannel: "telegram",
  };

  it("lets a host-admitted event that needs no reply end silently", () => {
    expect(
      resolveCommandReplyExpectation({ ...direct, opts: { hostAdmittedReplyOptional: true } }),
    ).toBe("optional");
  });

  it("keeps an ordinary direct turn and a private completion owed", () => {
    expect(resolveCommandReplyExpectation({ ...direct, opts: {} })).not.toBe("optional");
    expect(
      resolveCommandReplyExpectation({
        ...direct,
        opts: { privateCompletion: true, hostAdmittedReplyOptional: true },
      }),
    ).toBe("required");
  });
});
