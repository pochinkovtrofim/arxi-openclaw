import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Default delay between the first transcript change and the session re-index it triggers. */
const DEFAULT_SESSION_SYNC_DEBOUNCE_MS = 5_000;

/**
 * The memory-core `sessionSync.debounceMs` plugin setting: how long committed transcript
 * changes collect before one session re-index runs. The manifest schema bounds it; the
 * guard only keeps a hand-built config from arming a zero or runaway timer.
 */
export function resolveSessionSyncDebounceMs(cfg: OpenClawConfig): number {
  const pluginConfig = asNullableRecord(
    asNullableRecord(cfg.plugins?.entries?.["memory-core"])?.config,
  );
  const configured = asNullableRecord(pluginConfig?.sessionSync)?.debounceMs;
  return typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= 1_000 &&
    configured <= 3_600_000
    ? configured
    : DEFAULT_SESSION_SYNC_DEBOUNCE_MS;
}
