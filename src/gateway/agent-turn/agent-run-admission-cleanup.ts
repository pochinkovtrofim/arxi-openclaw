import { formatForLog } from "../ws-log.js";
import {
  releasePreparedAgentRunUserTurnAfterFailure,
  type PreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";

export async function releaseFailedAgentRunAdmission(
  userTurn: PreparedAgentRunUserTurn,
  error: unknown,
  cleanupPreaccept: () => Promise<void>,
) {
  const failure = releasePreparedAgentRunUserTurnAfterFailure(userTurn, error, "interrupted");
  try {
    await cleanupPreaccept();
  } catch (cleanupError) {
    throw new AggregateError(
      [failure, cleanupError],
      `${formatForLog(failure)}; agent admission cleanup failed: ${formatForLog(cleanupError)}`,
      { cause: cleanupError },
    );
  }
  return failure;
}
