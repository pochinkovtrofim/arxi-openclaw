/** Keeps a quiet chat's one-hour prompt cache warm by replaying its last request without output. */
export type AnthropicCacheKeepWarm = {
  /** Session whose last successful request is replayed. */
  key: string;
  /** Stop replaying this long after the session's last request. */
  maxIdleMs: number;
};

type Hold = { modelId: string; touchedAt: number; timer?: ReturnType<typeof setTimeout> };

const CACHE_TTL_MS = 60 * 60_000;
// Refresh five minutes before the entry expires.
const REFRESH_AFTER_MS = 55 * 60_000;
// A Gateway serves few quiet chats at once; the least recent one goes cold first.
const MAX_HELD_SESSIONS = 8;
const holds = new Map<string, Hold>();

/** A request for this session is starting; no replay runs until it settles. */
export function pauseAnthropicCacheKeepWarm(key: string): void {
  const hold = holds.get(key);
  if (hold) {
    clearTimeout(hold.timer);
    holds.set(key, { modelId: hold.modelId, touchedAt: hold.touchedAt });
  }
}

/** Replays the session's last request each time it has been quiet for 55 minutes. */
export function holdAnthropicCacheKeepWarm(
  keepWarm: AnthropicCacheKeepWarm,
  modelId: string,
  requestedAt: number,
  replay: () => Promise<boolean>,
): void {
  pauseAnthropicCacheKeepWarm(keepWarm.key);
  holds.delete(keepWarm.key);
  const hold: Hold = { modelId, touchedAt: requestedAt };
  holds.set(keepWarm.key, hold);
  for (const [key, oldest] of holds) {
    if (holds.size <= MAX_HELD_SESSIONS) {
      break;
    }
    clearTimeout(oldest.timer);
    holds.delete(key);
  }
  const arm = () => {
    const dueAt = hold.touchedAt + REFRESH_AFTER_MS;
    if (dueAt - requestedAt > keepWarm.maxIdleMs) {
      return;
    }
    hold.timer = setTimeout(() => void refresh(), Math.max(0, dueAt - Date.now()));
    hold.timer.unref?.();
  };
  const refresh = async () => {
    const startedAt = Date.now();
    // A Gateway that slept past the TTL would pay to write the entry again.
    if (startedAt - hold.touchedAt >= CACHE_TTL_MS) {
      return;
    }
    const refreshed = await replay().catch(() => false);
    if (refreshed && holds.get(keepWarm.key) === hold) {
      hold.touchedAt = startedAt;
      arm();
    }
  };
  arm();
}

/** When this session's last request or replay for the model reached the cache. */
export function readAnthropicCacheKeepWarmTouch(key: string, modelId: string): number | undefined {
  const hold = holds.get(key);
  return hold?.modelId === modelId ? hold.touchedAt : undefined;
}
