import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

type BoundTaskFlowRuntime = ReturnType<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>;
function createTaskFlowSessionMock(): BoundTaskFlowRuntime {
  return {
    sessionKey: "agent:main:main",
    createManaged: vi.fn<BoundTaskFlowRuntime["createManaged"]>(),
    tryCreateManaged: vi.fn<BoundTaskFlowRuntime["tryCreateManaged"]>(),
    hasCurrentAutomationObligationCapability: vi.fn<
      BoundTaskFlowRuntime["hasCurrentAutomationObligationCapability"]
    >(() => false),
    createManagedWithCurrentAutomationObligation:
      vi.fn<BoundTaskFlowRuntime["createManagedWithCurrentAutomationObligation"]>(),
    commitWithCurrentAutomationObligation:
      vi.fn<BoundTaskFlowRuntime["commitWithCurrentAutomationObligation"]>(),
    registerHistoryController: vi.fn<BoundTaskFlowRuntime["registerHistoryController"]>(),
    get: vi.fn<BoundTaskFlowRuntime["get"]>(),
    list: vi.fn<BoundTaskFlowRuntime["list"]>(() => []),
    findLatest: vi.fn<BoundTaskFlowRuntime["findLatest"]>(),
    resolve: vi.fn<BoundTaskFlowRuntime["resolve"]>(),
    setWaiting: vi.fn<BoundTaskFlowRuntime["setWaiting"]>(),
    resume: vi.fn<BoundTaskFlowRuntime["resume"]>(),
    finish: vi.fn<BoundTaskFlowRuntime["finish"]>(),
    fail: vi.fn<BoundTaskFlowRuntime["fail"]>(),
    requestCancel: vi.fn<BoundTaskFlowRuntime["requestCancel"]>(),
  };
}

export function createPluginTasksRuntimeMock(): PluginRuntime["tasks"] {
  return {
    managedFlows: {
      bindSession:
        vi.fn<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>(createTaskFlowSessionMock),
      fromToolContext:
        vi.fn<PluginRuntime["tasks"]["managedFlows"]["fromToolContext"]>(createTaskFlowSessionMock),
    },
  };
}
