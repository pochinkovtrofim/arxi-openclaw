import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import { describeAgentRunErrorIdentity } from "../../agents/agent-run-error-identity.js";
import { errorShapeFromError } from "../error-shape.js";

/**
 * An agent run's untyped failure, with its bounded identity (kind of error,
 * where it was thrown) in `details.errorIdentity`. A client that must not read
 * the error text, such as Ro's guest, can still name it; typed details stay as
 * their owner wrote them.
 */
export function agentRunErrorShapeFromError(
  code: Parameters<typeof errorShapeFromError>[0],
  error: unknown,
): ErrorShape {
  const shape = errorShapeFromError(code, error);
  if (shape.details !== undefined) {
    return shape;
  }
  const errorIdentity = describeAgentRunErrorIdentity({ error });
  return errorIdentity ? { ...shape, details: { errorIdentity } } : shape;
}
