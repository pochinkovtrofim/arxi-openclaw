/** Plugin-owned MCP server connection resolver contracts. */

/**
 * Trusted runtime identity for per-requester MCP connection resolution.
 * Only host-provided fields; plugins must not invent sender identity.
 * Future trusted fields (for example cron/subagent user context) can be added additively.
 */
export type McpServerConnectionResolveContext = {
  /** Trusted message sender id when the run has a current human requester. */
  requesterSenderId?: string;
  /** Channel account id that received the message. */
  agentAccountId?: string;
  /** Message channel id (for example telegram or slack). */
  messageChannel?: string;
  /** Agent selected by the admitted run. */
  agentId?: string;
  /** Canonical session key selected by core. */
  sessionKey?: string;
  /** Admitted conversation shape (for example direct or group). */
  chatType?: string;
  /** Canonical conversation or topic id selected by core. */
  conversationId?: string;
  /** Runtime lifecycle generation selected by core. */
  runtimeGeneration?: string;
  /** Diagnostic trace id selected by core for cross-boundary audit correlation. */
  traceId?: string;
};

/** Transport connection resolved for one requester-scoped MCP server. */
export type McpServerConnectionResolved = {
  url: string;
  /** Per-user credentials; never logged, fingerprinted, or persisted by core. */
  headers?: Record<string, string>;
};

/**
 * Plugin-owned connection resolver for a statically declared MCP server.
 * Server name/tool surface stay static; only the transport is requester-bound.
 */
export type OpenClawPluginMcpServerConnectionResolver = {
  /** Server name matching `mcp.servers` / bundle MCP declaration. */
  serverName: string;
  /**
   * Keep the default requester requirement unless the connection is authorized
   * by a separate host boundary using canonical agent and session identity.
   */
  requiresRequesterIdentity?: boolean;
  resolve: (
    ctx: McpServerConnectionResolveContext,
  ) => McpServerConnectionResolved | null | Promise<McpServerConnectionResolved | null>;
};

/** Registry entry for a plugin MCP server connection resolver. */
export type PluginMcpServerConnectionResolverRegistration = {
  pluginId: string;
  pluginName?: string;
  resolver: OpenClawPluginMcpServerConnectionResolver;
  source: string;
  rootDir?: string;
};
