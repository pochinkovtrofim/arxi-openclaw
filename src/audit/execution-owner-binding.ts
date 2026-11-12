import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { parseExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";

export type ExecutionOwnerBindingResult =
  | "disabled"
  | "bound"
  | "already-bound"
  | "mismatch"
  | "missing";

/** Extracts only an admitted exact identity; operational run correlation cannot bind owner rows. */
export function executionOwnerBindingFromAdmission(
  admitted: AdmittedRunContext,
): { contextId: string; executionId: string } | undefined {
  if (!admitted.executionIdentityToken) {
    return undefined;
  }
  const token = parseExecutionIdentityAdmissionToken(admitted.executionIdentityToken);
  if (token.runId !== admitted.operationalRunInstance.runId) {
    throw new Error("owner execution binding disagrees with the admitted run");
  }
  return { contextId: token.contextId, executionId: token.executionId };
}

/** Adds one exact owner write after admission resolves, never inside the admission callback. */
export function withPostAdmissionExecutionOwnerBinding(
  prepared: PreparedAgentRunAdmission,
  bind: (context: AdmittedRunContext) => void | Promise<void>,
): PreparedAgentRunAdmission {
  let binding: Promise<void> | undefined;
  return Object.freeze({
    ...prepared,
    admit: async (runtimeKind, runtimeInstanceId) => {
      const admitted = await prepared.admit(runtimeKind, runtimeInstanceId);
      const assertActive = resolveAdmittedRunActiveAssertion(admitted);
      if (!assertActive) {
        throw new Error("prepared execution authority closed during owner binding");
      }
      binding ??= Promise.resolve().then(() => {
        assertActive();
        return bind(admitted);
      });
      await binding;
      assertActive();
      return admitted;
    },
  });
}
