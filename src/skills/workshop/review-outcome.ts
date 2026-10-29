import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkshopChange } from "./changes.kernel.js";

const log = createSubsystemLogger("skills/workshop");

/**
 * A background Workshop run fails only when the model or runtime failed. Tool errors — a refused
 * write, a gated tool, a patch that did not match — are the model's to handle, not run failures.
 */
export function assertSkillReviewRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const runtimeErrorPayload = result.payloads?.find(
    (payload) => payload.isError && !getReplyPayloadMetadata(payload)?.toolErrorWarning,
  );
  const message =
    result.meta.error?.message.trim() ||
    (result.meta.aborted ? "Skill review model run aborted." : undefined) ||
    runtimeErrorPayload?.text?.trim();
  if (message || runtimeErrorPayload) {
    throw new Error(message || "Skill review model run failed.");
  }
}

const ACTION_VERB: Record<WorkshopChange["action"], string> = {
  create: "created",
  patch: "updated",
  write_file: "updated",
  remove_file: "updated",
  archive: "archived",
  restore: "restored",
};

/** Undo keeps the version before the review's first edit of each skill; a creation is archived. */
function formatWorkshopUndoContext(changes: readonly WorkshopChange[]) {
  const bySkill = new Map<string, WorkshopChange>();
  const firstBySkill = new Map<string, WorkshopChange>();
  for (const change of changes.toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
    if (!firstBySkill.has(change.skillName)) {
      firstBySkill.set(change.skillName, change);
    }
    if (bySkill.get(change.skillName)?.action !== "create") {
      bySkill.set(change.skillName, change);
    }
  }
  const parts = [...bySkill.values()].map((change) => {
    const summary = change.summary.trim();
    return `${ACTION_VERB[change.action]} ${change.skillName}${summary ? ` (${summary})` : ""}`;
  });
  // No prior version means the review created the skill, so undo archives it.
  const reverts = [...firstBySkill.values()].map(({ skillName, versionId }) =>
    versionId
      ? `skill_workshop action=restore name=${skillName} version=${versionId}`
      : `skill_workshop action=archive name=${skillName} reason="undo"`,
  );
  return `A background skill review just changed your learned skills: ${parts.join("; ")}. The user was not told in chat; do not bring it up yourself. If the user asks to undo or revert it, call ${reverts.join("; then ")}.`;
}

/**
 * Hands a review's changes to the originating conversation: the next foreground turn gets a
 * system event naming the exact revert call, so "undo" works. Nothing is posted to the chat;
 * the foreground reply already answered the user. A conversation reset or replaced since the
 * review started gets nothing.
 */
export function postWorkshopChangeNotice(params: {
  /** The reviewed session generation; the notice belongs to it, not to a later reset. */
  generation: SessionDeliveryGeneration;
  changes: readonly WorkshopChange[];
}): void {
  if (params.changes.length === 0) {
    return;
  }
  const { agentId, sessionKey, storePath, sessionId, lifecycleRevision } = params.generation;
  const current = loadSessionEntryReadOnly({
    agentId,
    sessionKey,
    storePath,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
  });
  if (
    current?.sessionId !== sessionId ||
    (current.lifecycleRevision ?? null) !== lifecycleRevision
  ) {
    log.debug(`skill workshop notice skipped: session ${sessionKey} was reset`);
    return;
  }
  enqueueSystemEvent(formatWorkshopUndoContext(params.changes), {
    sessionKey: resolveSystemEventQueueKey(sessionKey, agentId),
  });
}
