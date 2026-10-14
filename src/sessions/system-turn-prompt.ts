// Canonical prefix for model-facing internal system turns (restart recovery,
// stranded-reply retry, subagent resume). Lives outside input-provenance so the
// helper stays core-internal instead of widening the plugin SDK API surface.
const SYSTEM_TURN_PROMPT_PREFIX = "[System]";

export function formatSystemTurnPrompt(body: string): string {
  const trimmedBody = body.trim();
  return trimmedBody.startsWith(SYSTEM_TURN_PROMPT_PREFIX)
    ? trimmedBody
    : `${SYSTEM_TURN_PROMPT_PREFIX} ${trimmedBody}`;
}

/** True for a prompt the host built as an internal system turn. */
export function isSystemTurnPrompt(prompt: string): boolean {
  return prompt.trim().startsWith(SYSTEM_TURN_PROMPT_PREFIX);
}
