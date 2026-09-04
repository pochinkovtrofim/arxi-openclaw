const MAX_REJECTED_MCP_NAMES_IN_NOTICE = 8;
const MAX_REJECTED_MCP_NAME_LENGTH = 80;

function sanitizeRejectedMcpName(name: string): string {
  return name.replace(/[^a-z0-9_.:-]/giu, "?").slice(0, MAX_REJECTED_MCP_NAME_LENGTH);
}

/** Keep model-facing authority diagnostics bounded without weakening filtering. */
export function formatScheduledMcpIdentityMismatch(rejectedNames: readonly string[]): string {
  const shown = rejectedNames
    .slice(0, MAX_REJECTED_MCP_NAMES_IN_NOTICE)
    .map(sanitizeRejectedMcpName);
  const remaining = rejectedNames.length - shown.length;
  return `${shown.join(", ")}${remaining > 0 ? `; +${remaining} more` : ""}; total=${rejectedNames.length}`;
}
