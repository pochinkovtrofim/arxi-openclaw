import {
  registerMemoryArtifactSourceScope,
  clearInactiveMemoryArtifactSourceScope,
} from "../memory/memory-artifact-source-authority.js";
import type { PluginHookAgentContext, PluginHookToolAuthority } from "./hook-types.js";

export function withMemoryArtifactSourceContext(
  ctx: PluginHookAgentContext,
  authority: PluginHookToolAuthority,
  assertHostActive: () => void,
): PluginHookAgentContext {
  return {
    ...ctx,
    toolAuthority: authority,
    ...(ctx.runId && ctx.workspaceDir
      ? {
          memoryArtifactSources: Object.freeze({
            register(input: {
              refs: readonly { ownerId: string; value: string }[];
              complete: boolean;
            }) {
              authority.assertActive();
              registerMemoryArtifactSourceScope({
                ...input,
                runId: ctx.runId!,
                workspaceDir: ctx.workspaceDir!,
                assertCurrent: assertHostActive,
              });
            },
          }),
        }
      : {}),
  };
}

export async function withMemoryArtifactSourceScopeCleanup<T>(
  runId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    if (runId) {
      clearInactiveMemoryArtifactSourceScope(runId);
    }
  }
}

export function withAgentRunId<TEvent extends { runId?: string }>(
  event: TEvent,
  ctx: PluginHookAgentContext,
): TEvent {
  if (event.runId || !ctx.runId) {
    return event;
  }
  return { ...event, runId: ctx.runId };
}
