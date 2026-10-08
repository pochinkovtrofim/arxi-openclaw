import { afterEach, expect, it, vi } from "vitest";
import { renderAssistantRequestFailureCopy } from "../agents/failover/assistant-request-failure-copy.js";
import {
  formatBillingErrorMessage,
  renderExternalRunFailureText,
  renderHeartbeatRunFailureCopy,
  renderRateLimitOrOverloadedCopy,
} from "../agents/failover/user-copy.js";
import { formatTransportErrorCopy } from "../shared/assistant-error-format.js";
import { renderUserMessage } from "../shared/user-message.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

// These production modules are intentionally imported before plugin activation.
afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

function registry(text: string) {
  return createMockPluginRegistry([
    { hookName: "user_message", pluginId: "presentation", handler: () => ({ text }) },
  ]);
}

it("renders lazily through the current registry and request scope", async () => {
  const fallback = renderExternalRunFailureText();
  const root = registry("root copy");
  setActivePluginRegistry(root);
  initializeGlobalHookRunner(root);
  expect(renderExternalRunFailureText()).toBe("root copy");
  expect(formatTransportErrorCopy("ECONNRESET")).toBe("root copy");
  await withPluginRuntimeRegistryScope(registry("request copy"), async () => {
    expect(renderExternalRunFailureText()).toBe("request copy");
  });
  expect(renderExternalRunFailureText()).toBe("root copy");
  const replacement = createMockPluginRegistry([]);
  setActivePluginRegistry(replacement);
  initializeGlobalHookRunner(replacement);
  expect(renderExternalRunFailureText()).toBe(fallback);
  resetGlobalHookRunner();
  expect(renderUserMessage({ code: "session_reset" }, "default")).toBe("default");
});

it("passes classified presentation facts without provider diagnostics", () => {
  const handler = vi.fn((_event: unknown) => ({ text: "safe copy" }));
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "user_message", handler }]));
  const secret = "private-provider-diagnostic";
  expect(formatBillingErrorMessage(secret, secret, "oauth")).toBe("safe copy");
  expect(
    renderRateLimitOrOverloadedCopy({
      reason: "rate_limit",
      raw: `quota resets in 10 min: ${secret}`,
    }),
  ).toBe("safe copy");
  expect(renderHeartbeatRunFailureCopy(secret)).toBe("safe copy");
  expect(
    renderAssistantRequestFailureCopy({
      provider: secret,
      model: secret,
      reason: "auth",
      status: 401,
    }),
  ).toBe("safe copy");
  expect(handler.mock.calls.map(([event]) => event)).toEqual([
    { code: "billing" },
    { code: "rate_limit" },
    { code: "heartbeat_failure" },
    { code: "assistant_request_failure", reason: "auth" },
  ]);
});

it("uses the first synchronous nonempty result and preserves defaults on failures", () => {
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "user_message",
        priority: 4,
        handler: () => {
          throw new Error("renderer failed");
        },
      },
      {
        hookName: "user_message",
        priority: 3,
        handler: () => Promise.reject(new Error("async is unsupported")),
      },
      { hookName: "user_message", priority: 2, handler: () => ({ text: " " }) },
      { hookName: "user_message", priority: 1, handler: () => ({ text: "selected" }) },
      { hookName: "user_message", priority: 0, handler: () => ({ text: "ignored" }) },
    ]),
  );
  expect(renderUserMessage({ code: "session_reset" }, "default")).toBe("selected");
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "user_message", handler: () => undefined }]),
  );
  expect(renderUserMessage({ code: "session_reset" }, "default")).toBe("default");
});
