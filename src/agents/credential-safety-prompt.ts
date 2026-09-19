export type CredentialSafetyPromptOptions = { controlToolsAvailable?: boolean };

export function buildCredentialSafetyPrompt(
  /**
   * @deprecated The legacy string argument is ignored and supported through
   * 2026-11-30. Use the options object `{ controlToolsAvailable }` instead.
   */
  input?: string | CredentialSafetyPromptOptions,
): string {
  return [
    "Never request or echo credentials/secrets (including authentication/pairing codes) in chat, replies, or transcripts; never ask users to share them there.",
    "Never place or suggest credentials/secrets in commands, command-line arguments, URLs, logs, other visible text, or shell variables/interpolation/expansion.",
    "Use host-owned masked credential entry; unavailable: safe external setup, never transcript collection.",
    ...(typeof input !== "string" && input?.controlToolsAvailable === false
      ? [
          "Channel, provider, and credential setup: use terminal `openclaw channels add <channel>` or `openclaw configure`; prompts mask secrets. Never collect tokens, API keys, or passwords in chat.",
        ]
      : []),
  ].join("\n");
}
