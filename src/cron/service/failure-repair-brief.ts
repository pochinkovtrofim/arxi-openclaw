/** The repair request the scheduler posts into a failing automation's owner conversation. */
import type { FailoverReason } from "../../agents/failover/signal.js";
import { wrapUntrustedPromptDataBlock } from "../../agents/sanitize-for-prompt.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { CronJob } from "../types.js";

const REPAIR_PAYLOAD_MAX_CHARS = 4_000;
const REPAIR_ERROR_MAX_CHARS = 3_000;
const REPAIR_TOOLS_MAX_CHARS = 1_500;

// The conversation, not the scheduler, knows the user's language and what they already heard.
const USER_MESSAGE_RULE =
  "Whatever you tell the user, write as yourself, to them, in the language you speak with them in this conversation: what the automation already found or did, one plain sentence on what is missing, and one action they can take. No lists of steps, tools or errors.";

function describeToolCeiling(job: CronJob): string | undefined {
  const payload = job.payload;
  if (payload.kind !== "agentTurn" && payload.kind !== "script") {
    return undefined;
  }
  const tools = payload.toolsAllow;
  if (!Array.isArray(tools) || tools.includes("*")) {
    return "Tools its runs get: every tool of its creator's conversation.";
  }
  if (tools.length === 0) {
    return "Tools its runs get: none.";
  }
  const list = tools.join(", ");
  return `Tools its runs get (payload.toolsAllow): ${
    list.length > REPAIR_TOOLS_MAX_CHARS
      ? `${list.slice(0, REPAIR_TOOLS_MAX_CHARS)} [truncated]`
      : list
  }.`;
}

export function buildCronFailureRepairBrief(params: {
  job: CronJob;
  consecutiveErrors: number;
  error?: string;
  errorReason?: FailoverReason;
  terminal?: boolean;
  /** The last run reported AUTOMATION_FAILED itself rather than hitting a runtime fault. */
  reportedByAgent?: boolean;
  /** A repair was already requested in this streak and the job still fails. */
  followUp?: boolean;
}): string {
  const { job } = params;
  const payload = job.payload;
  const payloadText =
    payload.kind === "agentTurn"
      ? payload.message
      : payload.kind === "systemEvent"
        ? payload.text
        : payload.kind === "script"
          ? payload.script
          : "";
  const error = [params.errorReason ? `cause: ${params.errorReason}` : "", params.error?.trim()]
    .filter(Boolean)
    .join("\n");
  const reported = params.reportedByAgent
    ? "; its last run reported that it could not do its work"
    : "";
  const fixSteps =
    "Fixable by you: a tool or access its runs lack that you have in this conversation (add it with automations update, giving payload.toolsAllow as the current list plus the missing tool names exactly as you see them), or the helper script or instructions file the payload follows.";
  const runNow = `fix it, run it now with automations run (runMode "force") so the user still gets this run's result, and reply exactly ${SILENT_REPLY_TOKEN}`;
  const toolCeiling = describeToolCeiling(job);
  return [
    params.followUp
      ? `Automation follow-up from the scheduler, not a user message. Do not relay it; follow the steps below.`
      : `Automation repair request from the scheduler, not a user message. Do not relay it; follow the steps below.`,
    params.terminal
      ? `A one-time automation (id ${job.id}), created in this conversation, failed and will not run again (now disabled)${reported}. No failure alert was sent.`
      : params.followUp
        ? `An automation (id ${job.id}), created in this conversation, still fails after a repair request: ${params.consecutiveErrors} consecutive runs${reported}. No failure alert was sent.`
        : `An automation (id ${job.id}), created in this conversation, failed ${params.consecutiveErrors} consecutive runs${reported}. No failure alert was sent.`,
    `Schedule: ${JSON.stringify(job.schedule)}. Payload kind: ${payload.kind}. Session: ${job.sessionTarget}.`,
    ...(toolCeiling ? [toolCeiling] : []),
    // Job text and provider errors can carry third-party content: data, never instructions.
    wrapUntrustedPromptDataBlock({ label: "Automation name", text: job.name, maxChars: 200 }),
    wrapUntrustedPromptDataBlock({
      label: "Current payload",
      text: payloadText,
      maxChars: REPAIR_PAYLOAD_MAX_CHARS,
      truncationMarker: " [truncated]",
    }),
    wrapUntrustedPromptDataBlock({
      label: "Last error",
      text: error || "No error text recorded.",
      maxChars: REPAIR_ERROR_MAX_CHARS,
      truncationMarker: " [truncated]",
    }),
    "",
    "Diagnose the failure, then do exactly one:",
    ...(params.terminal
      ? [
          "1. If its work is still needed and you can do it now, do it; the failed automation stays disabled.",
          `2. If the work is no longer needed, reply exactly ${SILENT_REPLY_TOKEN}.`,
          "3. Otherwise, ask the user for what you need to continue.",
          USER_MESSAGE_RULE,
        ]
      : params.followUp
        ? [
            `1. ${fixSteps} If it is fixable now: ${runNow}.`,
            `2. If you already told the user about this problem in this conversation and nothing changed since, reply exactly ${SILENT_REPLY_TOKEN}.`,
            "3. Otherwise tell the user once what is not working and the one action that fixes it; if the automation is no longer useful, disable it with automations update and say so in one line.",
            USER_MESSAGE_RULE,
          ]
        : [
            `1. Transient (provider outage, network, rate limit, or temporary upstream error): change nothing and reply exactly ${SILENT_REPLY_TOKEN}.`,
            `2. ${fixSteps} Then ${runNow}.`,
            "3. Otherwise (access that is not connected, or a choice only the user can make): tell the user once what you need.",
            USER_MESSAGE_RULE,
            "If the automation keeps failing, you get one follow-up request.",
          ]),
  ].join("\n");
}
