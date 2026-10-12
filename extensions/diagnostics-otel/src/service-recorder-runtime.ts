import type { DiagnosticsMetrics } from "./service-metrics.js";
import type { DiagnosticsTraceRuntime } from "./service-traces.js";

// memory_search reports its dominant phase before the tool lifecycle settles;
// the tool.execution span of the same call carries it as a bounded attribute.
// A lifecycle that never settles must not pin its entry forever.
const MAX_PENDING_MEMORY_SEARCH_PHASES = 256;

export function createMemorySearchPhaseTracker() {
  const pendingMemorySearchPhases = new Map<string, string>();
  return {
    rememberMemorySearchPhase: (toolCallId: string, phase: string) => {
      pendingMemorySearchPhases.delete(toolCallId);
      pendingMemorySearchPhases.set(toolCallId, phase);
      if (pendingMemorySearchPhases.size > MAX_PENDING_MEMORY_SEARCH_PHASES) {
        const oldest = pendingMemorySearchPhases.keys().next().value;
        if (oldest !== undefined) {
          pendingMemorySearchPhases.delete(oldest);
        }
      }
    },
    takeMemorySearchPhase: (toolCallId: string | undefined): string | undefined => {
      if (toolCallId === undefined) {
        return undefined;
      }
      const phase = pendingMemorySearchPhases.get(toolCallId);
      pendingMemorySearchPhases.delete(toolCallId);
      return phase;
    },
  };
}

export type DiagnosticsRecorderRuntime = DiagnosticsMetrics &
  DiagnosticsTraceRuntime &
  ReturnType<typeof createMemorySearchPhaseTracker> & {
    captureContent: boolean;
    tracesEnabled: boolean;
  };
