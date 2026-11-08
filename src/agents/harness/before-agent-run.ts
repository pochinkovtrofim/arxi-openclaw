import { resolveBlockMessage, resolveHoldReason } from "../../plugins/hook-decision-types.js";
import type { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentRunEvent,
} from "../../plugins/hook-types.js";

type HookRunner = Pick<
  NonNullable<ReturnType<typeof getGlobalHookRunner>>,
  "hasHooks" | "runBeforeAgentRun"
>;
type AgentRunBlock = { blockedBy: string; message: string; heldReason?: string };

/** A blocked run's prompt error; a held run also carries the reason scheduled work records. */
export class AgentRunBlockedError extends Error {
  readonly heldReason?: string;
  constructor(block: AgentRunBlock) {
    super(block.message);
    if (block.heldReason) {
      this.heldReason = block.heldReason;
    }
  }
}

export function resolveAgentRunHeldReason(error: unknown): string | undefined {
  return error instanceof AgentRunBlockedError ? error.heldReason : undefined;
}

export async function runBeforeAgentRunGate(
  runner: HookRunner | null | undefined,
  event: PluginHookBeforeAgentRunEvent,
  context: PluginHookAgentContext,
): Promise<AgentRunBlock | undefined> {
  if (!runner?.hasHooks("before_agent_run")) {
    return undefined;
  }
  let result: Awaited<ReturnType<HookRunner["runBeforeAgentRun"]>>;
  try {
    result = await runner.runBeforeAgentRun(
      { ...event, messages: structuredClone(event.messages) },
      context,
    );
  } catch {
    result = {
      pluginId: "before_agent_run",
      decision: { outcome: "block", reason: "before_agent_run hook failed" },
    };
  }
  if (result?.decision.outcome !== "block") {
    return undefined;
  }
  const blockedBy = result.pluginId ?? "unknown";
  const heldReason = resolveHoldReason(result.decision, { blockedBy });
  return {
    blockedBy,
    message: resolveBlockMessage(result.decision, { blockedBy }),
    ...(heldReason ? { heldReason } : {}),
  };
}

export function buildAgentRunBlockedUserMessage(runId: string, block: AgentRunBlock) {
  const timestamp = Date.now();
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text: block.message }],
    timestamp,
    idempotencyKey: `hook-block:before_agent_run:user:${runId}`,
    __openclaw: { beforeAgentRunBlocked: { blockedBy: block.blockedBy, blockedAt: timestamp } },
  };
}
