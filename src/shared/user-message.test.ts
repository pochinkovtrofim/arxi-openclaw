// A worker thread projects chat history without the hook runner; it renders the
// failure copy the main thread captured with the owner's hook.
import { afterEach, describe, expect, it } from "vitest";
import { renderRecordedAssistantFailureCopy } from "../agents/failover/assistant-request-failure-copy.js";
import {
  captureUserMessageCopy,
  installUserMessageCopy,
  resolveUserMessage,
  setUserMessageRenderer,
} from "./user-message.js";
import type { UserMessageEvent } from "./user-message.types.js";

const SIGN_IN_AGAIN = "Подключение подписки больше не действует.";

function ownerHook(event: UserMessageEvent): string | undefined {
  if (event.code === "assistant_request_failure") {
    return event.reason === "auth" ? SIGN_IN_AGAIN : `failure:${event.reason}`;
  }
  if (event.code === "model_fallback") {
    return `fallback:${event.activeModel}`;
  }
  return `copy:${event.code}`;
}

afterEach(() => setUserMessageRenderer(undefined));

describe("user message copy for a thread without the hook runner", () => {
  // Production 2026-11-09: the Ro app showed the built-in English "run
  // `openclaw configure`" text for a 401 that Telegram worded in Russian.
  it("projects a recorded 401 with the owner's copy", () => {
    setUserMessageRenderer(ownerHook);
    const copy = captureUserMessageCopy();
    setUserMessageRenderer(undefined);
    const recorded = {
      errorMessage:
        '401 {"error":{"message":"OAuth access token has expired. Re-authenticate to continue.","type":"authentication_error"}}',
    };
    expect(renderRecordedAssistantFailureCopy(recorded)).toContain("openclaw configure");

    installUserMessageCopy(copy);

    expect(renderRecordedAssistantFailureCopy(recorded)).toBe(SIGN_IN_AGAIN);
  });

  it("carries every parameter-free message and leaves parameterized ones to their fallback", () => {
    setUserMessageRenderer(ownerHook);
    const copy = captureUserMessageCopy();
    setUserMessageRenderer(undefined);
    installUserMessageCopy(copy);

    expect(resolveUserMessage({ code: "rate_limit" })).toBe("copy:rate_limit");
    expect(resolveUserMessage({ code: "assistant_request_failure", reason: "overloaded" })).toBe(
      "failure:overloaded",
    );
    expect(resolveUserMessage({ code: "model_fallback", activeModel: "m" })).toBeUndefined();
    expect(resolveUserMessage({ code: "auth_profile_failure", reason: "billing" })).toBeUndefined();
  });

  it("captures nothing without a hook and installs nothing from it", () => {
    expect(captureUserMessageCopy()).toBeUndefined();
    installUserMessageCopy(undefined);
    expect(resolveUserMessage({ code: "rate_limit" })).toBeUndefined();
  });
});
