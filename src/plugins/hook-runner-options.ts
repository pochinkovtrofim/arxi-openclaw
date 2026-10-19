import type { PluginHookName } from "./hook-types.js";

export type {
  HookFailurePolicy,
  HookRunnerOptions,
  VoidHookRunOptions,
} from "./hook-runner-types.js";

export const DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  agent_end: 30_000,
  channel_pairing_requested: 2_000,
  // Compaction hooks run on the serialized Codex notification queue. Match the
  // terminal agent hook budget so a stalled observer cannot freeze later events.
  before_compaction: 30_000,
  after_compaction: 30_000,
  skill_changed: 30_000,
  // Shutdown hooks share the Gateway's five-second teardown budget.
  gateway_stop: 5_000,
};

export const DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  before_agent_run: 15_000,
  before_install: 15_000,
  before_tool_call: 15_000,
  tool_result_transform: 2_000,
  before_agent_finalize: 15_000,
  before_prompt_build: 15_000,
  message_sending: 15_000,
  reply_payload_sending: 15_000,
  resolve_exec_env: 15_000,
};
