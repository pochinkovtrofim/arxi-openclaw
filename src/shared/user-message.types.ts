import type { FailoverReason } from "../agents/failover/signal.js";
import type { FixedUserMessageCode } from "./user-message-codes.js";

/** Semantic presentation facts only; no raw errors, credentials, or session content. */
export type UserMessageEvent =
  | {
      code: FixedUserMessageCode;
    }
  | { code: "model_fallback"; activeModel: string }
  | { code: "cooldown_seconds"; seconds: number }
  | { code: "cooldown_minutes"; minutes: number }
  | { code: "post_compaction_failed"; text: string }
  | { code: "auth_profile_failure" | "assistant_request_failure"; reason: FailoverReason }
  | {
      /** A scheduled automation kept failing; sent when no conversation turn speaks for it. */
      code: "automation_failed";
      jobName: string;
      count: number;
      skipped?: true;
      repairRequested?: true;
      reason?: FailoverReason;
    }
  | { code: "automation_delivery_failed"; jobName: string };
