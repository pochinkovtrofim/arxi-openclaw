import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";

/** A handler exceeded its hook budget; the runner skips its result. */
export class HookTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
  }
}

export const withHookTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  optionsResult: { unref?: boolean } = {},
): Promise<T> => {
  // The handler has started. Retain its work without replacing the raced promise
  // if its caller's scope has already closed; hook policy still owns its errors.
  void trackAsyncWork(() => promise).catch(() => {});
  return await raceWithTimeout(
    promise,
    timeoutMs,
    () => {
      throw new HookTimeoutError(timeoutMs);
    },
    { ref: !optionsResult.unref },
  );
};
