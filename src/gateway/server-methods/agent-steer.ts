import {
  ErrorCodes,
  errorShape,
  validateAgentSteerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSteerRequestError, steerActiveAgentRun } from "../agent-turn/agent-steer.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentSteerHandler: GatewayRequestHandlers["agent.steer"] = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateAgentSteerParams, "agent.steer", respond)) {
    return;
  }
  try {
    respond(true, await steerActiveAgentRun({ request: params, client: client ?? null, context }));
  } catch (error) {
    respond(
      false,
      undefined,
      errorShape(
        error instanceof AgentSteerRequestError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
};
