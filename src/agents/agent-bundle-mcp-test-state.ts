const BUNDLE_MCP_TEST_STATE_KEY = Symbol.for("openclaw.bundleMcpTestState");

type BundleMcpTestState = { disposeTimeoutMs?: number };

export function getBundleMcpTestState(): BundleMcpTestState {
  // SAFETY: globalThis is an object with symbol-keyed properties.
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  // SAFETY: this symbol is written below only with BundleMcpTestState values.
  const existing = globalStore[BUNDLE_MCP_TEST_STATE_KEY] as BundleMcpTestState | undefined;
  if (existing) {
    return existing;
  }
  const state: BundleMcpTestState = {};
  globalStore[BUNDLE_MCP_TEST_STATE_KEY] = state;
  return state;
}
