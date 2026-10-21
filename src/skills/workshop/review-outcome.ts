import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { extractDeliveryInfo } from "../../config/sessions/delivery-info.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { SKILL_REVIEW_USER_LINE_PREFIX } from "./experience-review-prompt.js";

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

const MAX_USER_LINE_CHARS = 160;

/**
 * The review's line for the user, or undefined. Changes are quiet by default and listed where
 * the user manages learned skills; a review that saved an explicit correction from the user may
 * confirm it in one short line it wrote in the user's language. A line that is long or names a
 * changed skill is not the plain confirmation the review was asked for, so it is dropped.
 */
export function readSkillReviewUserLine(
  payloads: EmbeddedAgentRunResult["payloads"],
  changes: readonly WorkshopChange[],
): string | undefined {
  if (changes.length === 0) {
    return undefined;
  }
  for (const payload of payloads ?? []) {
    if (payload.isError || payload.isReasoning || typeof payload.text !== "string") {
      continue;
    }
    for (const raw of payload.text.split("\n")) {
      const marked = raw.trim();
      if (!marked.startsWith(SKILL_REVIEW_USER_LINE_PREFIX)) {
        continue;
      }
      const line = marked
        .slice(SKILL_REVIEW_USER_LINE_PREFIX.length)
        .replaceAll("`", "")
        .replace(/\s+/g, " ")
        .trim();
      // Only the first marked line counts; one naming a skill or its file is dropped.
      const lower = line.toLowerCase();
      const namesSkill =
        /\.md\b/.test(lower) ||
        changes.some(
          ({ skillName }) => skillName.includes("-") && lower.includes(skillName.toLowerCase()),
        );
      return line && line.length <= MAX_USER_LINE_CHARS && !namesSkill ? line : undefined;
    }
  }
  return undefined;
}

/** Undo keeps the version before the review's first edit of each skill; a creation is archived. */
function formatWorkshopUndoContext(changes: readonly WorkshopChange[], userLine?: string) {
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
  const told = userLine
    ? `You told the user: "${userLine}"`
    : "The user was not told in chat; do not bring it up yourself.";
  return `A background skill review just changed your learned skills: ${parts.join("; ")}. ${told} If the user asks to undo or revert it, call ${reverts.join("; then ")}.`;
}

/**
 * Hands a review's changes to the originating conversation. The next foreground turn gets a
 * system event naming the exact revert call, so "undo" works whether or not the user was told.
 * Only the review's own user line is posted: external channels get a durable send mirrored
 * into the session transcript; channel-less sessions (Control UI) get a transcript entry.
 * A conversation reset or replaced since the review started gets none of it.
 */
export async function postWorkshopChangeNotice(params: {
  config: OpenClawConfig;
  /** The reviewed session generation; the notice belongs to it, not to a later reset. */
  generation: SessionDeliveryGeneration;
  runId: string;
  changes: readonly WorkshopChange[];
  /** From {@link readSkillReviewUserLine}; without it the change stays out of the chat. */
  userLine?: string;
}): Promise<void> {
  if (params.changes.length === 0) {
    return;
  }
  const { generation } = params;
  const { agentId, sessionKey } = generation;
  const isReviewedGeneration = () => {
    const current = loadSessionEntryReadOnly({
      agentId,
      sessionKey,
      storePath: generation.storePath,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    return (
      current?.sessionId === generation.sessionId &&
      (current.lifecycleRevision ?? null) === generation.lifecycleRevision
    );
  };
  if (!isReviewedGeneration()) {
    log.debug(`skill workshop notice skipped: session ${sessionKey} was reset`);
    return;
  }
  const text = params.userLine;
  enqueueSystemEvent(formatWorkshopUndoContext(params.changes, text), {
    sessionKey: resolveSystemEventQueueKey(sessionKey, agentId),
  });
  if (!text) {
    log.debug(`skill workshop change kept out of chat: session ${sessionKey}`);
    return;
  }
  const idempotencyKey = `skill-workshop-notice:${params.runId}`;
  try {
    const { deliveryContext: target, threadId } = extractDeliveryInfo(sessionKey, {
      cfg: params.config,
    });
    const channel = target?.channel ? normalizeMessageChannel(target.channel) : undefined;
    if (channel && isDeliverableMessageChannel(channel) && target?.to) {
      // Delivery and transcript runtimes stay lazy: most reviews change nothing.
      const { sendDurableMessageBatchCore } = await import("../../channels/message/runtime.js");
      const send = await sendDurableMessageBatchCore(
        {
          cfg: params.config,
          channel,
          to: target.to,
          accountId: target.accountId,
          // The session key's thread is canonical; stored context may name a stale thread.
          threadId: threadId ?? target.threadId,
          payloads: [{ text }],
          session: buildOutboundSessionContext({ cfg: params.config, sessionKey, agentId }),
          mirror: {
            sessionKey,
            agentId,
            idempotencyKey,
            expectedSessionId: generation.sessionId,
          },
          bestEffort: true,
        },
        undefined,
        undefined,
        generation,
      );
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      return;
    }
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.runtime.js");
    const appended = await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey,
      storePath: generation.storePath,
      expectedSessionId: generation.sessionId,
      expectedLifecycleRevision: generation.lifecycleRevision,
      text,
      idempotencyKey,
      config: params.config,
    });
    if (!appended.ok) {
      throw new Error(appended.reason);
    }
  } catch (error) {
    if (!isReviewedGeneration()) {
      log.debug(`skill workshop notice skipped: session ${sessionKey} was reset`);
      return;
    }
    // The system event above still carries the change to the next turn.
    log.warn(`skill workshop notice delivery failed: ${String(error)}`);
  }
}
