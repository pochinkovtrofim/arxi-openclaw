import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
export function resetRuntimeTaskTestState(): void {
  resetTaskFlowRegistryForTests();
}
