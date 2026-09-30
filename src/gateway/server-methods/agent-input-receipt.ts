import {
  ErrorCodes,
  errorShape,
  validateAgentInputReceiptParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  loadSessionEntryReadOnly,
  readSessionExternalInputReceipt,
} from "../../config/sessions/session-accessor.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.metadata.js";
import { resolveCanUseInternalRuntimeHandoff } from "../agent-turn/agent-handler-helpers.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** The backend can inspect a receipt, but inspection never admits or resumes the input. */
export const agentInputReceiptHandler: GatewayRequestHandlers["agent.inputReceipt"] = ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateAgentInputReceiptParams, "agent.inputReceipt", respond)) {
    return;
  }
  if (!resolveCanUseInternalRuntimeHandoff(client)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "backend authority required"));
    return;
  }
  const { sessionKey, idempotencyKey, expectedRunId } = params;
  if (idempotencyKey !== buildRunUserTurnIdempotencyKey(expectedRunId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "external run identity mismatch"),
    );
    return;
  }
  const selected = resolveRequestedSessionAgentId(context.getRuntimeConfig(), sessionKey);
  if (!selected.ok) {
    respond(false, undefined, selected.error);
    return;
  }
  const agentId = selected.agentId;
  const entry = loadSessionEntryReadOnly({ agentId, sessionKey });
  if (!entry) {
    // A reset/deleted session cannot prove this input was never admitted.
    respond(true, { status: "uncertain" });
    return;
  }
  respond(
    true,
    readSessionExternalInputReceipt(
      { agentId, sessionKey, sessionId: entry.sessionId },
      idempotencyKey,
      expectedRunId,
    ),
  );
};
