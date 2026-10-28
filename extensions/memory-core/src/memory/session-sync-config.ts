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
  const configured = readSessionSyncSetting(cfg, "debounceMs");
  return typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= 1_000 &&
    configured <= 3_600_000
    ? configured
    : DEFAULT_SESSION_SYNC_DEBOUNCE_MS;
}

/**
 * The memory-core `sessionSync.startupCatchupDelayMs` plugin setting: how long a newly opened
 * index waits before it scans for transcripts that changed while no index watched them. Zero,
 * the default, scans at once; a delay keeps the scan's transcript reads off the turn that woke
 * the host. Out-of-contract values scan at once.
 */
export function resolveSessionStartupCatchupDelayMs(cfg: OpenClawConfig): number {
  const configured = readSessionSyncSetting(cfg, "startupCatchupDelayMs");
  return typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= 0 &&
    configured <= 3_600_000
    ? configured
    : 0;
}

function readSessionSyncSetting(cfg: OpenClawConfig, key: string): unknown {
  const pluginConfig = asNullableRecord(
    asNullableRecord(cfg.plugins?.entries?.["memory-core"])?.config,
  );
  return asNullableRecord(pluginConfig?.sessionSync)?.[key];
}
