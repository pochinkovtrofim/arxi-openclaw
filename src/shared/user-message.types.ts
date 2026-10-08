import type { FailoverReason } from "../agents/failover/signal.js";

/** Semantic presentation facts only; no raw errors, credentials, or session content. */
export type UserMessageEvent =
  | {
      code:
        | "all_models_limited"
        | "auth_invalid_token"
        | "billing"
        | "completion_unconfirmed"
        | "connection_failed"
        | "connection_interrupted"
        | "connection_refused"
        | "connection_retry_exhausted"
        | "context_overflow"
        | "context_recovery_failed"
        | "conversation_state"
        | "delivery_unconfirmed"
        | "disk_full"
        | "dns_failed"
        | "empty_response"
        | "endpoint_unreachable"
        | "external_run_failure"
        | "fallback_reply_missing"
        | "gateway_restarting"
        | "heartbeat_failure"
        | "media_delivery_failed"
        | "media_file_not_found"
        | "media_unsupported"
        | "message_order"
        | "missing_credentials"
        | "model_capacity"
        | "model_not_found"
        | "model_restored"
        | "model_unavailable"
        | "output_limit"
        | "overloaded"
        | "preflight_compaction_failed"
        | "provider_internal"
        | "provider_network"
        | "rate_limit"
        | "rate_limit_quota"
        | "rate_limit_retry"
        | "reminder_unscheduled"
        | "reply_missing"
        | "request_failed"
        | "schema_rejection"
        | "selected_auth_unavailable"
        | "server_error"
        | "session_changed"
        | "session_expired"
        | "session_reset"
        | "streaming_fragment"
        | "streaming_invalid"
        | "timeout"
        | "tls_certificate"
        | "unknown_error";
    }
  | { code: "model_fallback"; activeModel: string }
  | { code: "cooldown_seconds"; seconds: number }
  | { code: "cooldown_minutes"; minutes: number }
  | { code: "post_compaction_failed"; text: string }
  | { code: "auth_profile_failure" | "assistant_request_failure"; reason: FailoverReason };
