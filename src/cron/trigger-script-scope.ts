// Trigger evaluation scope: agent, guest namespace and plugin refresh owned by one invocation.
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type {
  CodeModeNamespaceDescriptor,
  SerializedCodeModeNamespaceValue,
} from "../agents/code-mode-namespaces.js";
import { createAgentPluginRuntimeRefresh } from "../agents/plugin-runtime-refresh.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export function resolveTriggerAgentId(config: OpenClawConfig, agentId?: string): string {
  return agentId?.trim() ? normalizeAgentId(agentId) : resolveDefaultAgentId(config);
}

export function triggerStateNamespace(
  state: unknown,
  streamBatch?: string,
): CodeModeNamespaceDescriptor {
  const entries: Array<[string, SerializedCodeModeNamespaceValue]> = [
    ["state", { kind: "value", value: state }],
  ];
  if (streamBatch !== undefined) {
    entries.push(["streamBatch", { kind: "value", value: streamBatch }]);
  }
  return {
    id: "cron:trigger",
    globalName: "trigger",
    scope: {
      kind: "object",
      entries,
    },
  };
}

/**
 * Scheduler callbacks can inherit the foreground turn that armed their timer. Each
 * invocation owns its refresh scope; a closed parent must not fence its tools.
 */
export function runInOwnPluginRuntimeRefresh<T>(run: () => Promise<T>): Promise<T> {
  const refresh = createAgentPluginRuntimeRefresh();
  return refresh.run(async () => {
    try {
      return await run();
    } finally {
      refresh.close();
    }
  });
}
