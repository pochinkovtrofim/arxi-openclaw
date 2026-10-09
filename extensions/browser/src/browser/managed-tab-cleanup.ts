/**
 * Reclaim idle pages in locally owned headless browsers without deleting their
 * profile, and stop the browser process itself once it has shown no page tabs
 * for `browser.idleStopMinutes` (0 keeps it resident).
 */
import { resolveCdpControlPolicy } from "./cdp-reachability-policy.js";
import { fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { isLocalManagedProfile } from "./config.js";
import { createBrowserRouteContext, runProfileContextOperation } from "./server-context.js";
import { getProfileLifecycle, isBrowserRuntimeRunning } from "./server-context.lifecycle.js";
import type {
  BrowserServerState,
  ProfileContext,
  ProfileRuntimeState,
} from "./server-context.types.js";
import { dispatchBrowserTabClose } from "./session-tab-store.js";

const MANAGED_TAB_IDLE_MS = 10 * 60_000;

function resolveIdleStopMs(state: BrowserServerState): number {
  const minutes = state.resolved.idleStopMinutes ?? 0;
  return minutes > 0 ? Math.floor(minutes * 60_000) : 0;
}

/**
 * Stop a managed browser that has shown no page tabs for the configured window
 * through the same lifecycle transition as the controller's `/stop` route. The
 * profile directory is untouched and the next browser action relaunches it.
 */
async function stopIdleManagedBrowser(params: {
  runtime: ProfileRuntimeState;
  profileCtx: ProfileContext;
  onWarn: (message: string) => void;
}): Promise<void> {
  const lifecycle = getProfileLifecycle(params.runtime);
  // The decision was made under the sweep's own lease. Anything admitted or
  // started since then keeps the browser; the next sweep decides again. There
  // is no await between this check and beginProfileTransition inside
  // stopRunningBrowser, so no action can be admitted in between. An action that
  // arrives afterwards waits on the transition and relaunches the browser; only
  // an admission that captured the previous generation in the same microtask
  // turn sees the same lifecycle error as an operator /stop and retries.
  if (
    lifecycle.leases.size > 0 ||
    lifecycle.starts.size > 0 ||
    lifecycle.transitionReason ||
    !params.runtime.running
  ) {
    return;
  }
  lifecycle.pagesIdleSince = null;
  try {
    await params.profileCtx.stopRunningBrowser();
  } catch {
    params.onWarn("Could not stop the idle managed browser; will retry next sweep.");
  }
}

export async function sweepIdleManagedBrowserTabs(
  state: BrowserServerState,
  onWarn: (message: string) => void,
): Promise<void> {
  if (!isBrowserRuntimeRunning(state) || !state.resolved.tabCleanup.enabled) {
    return;
  }
  const idleStopMs = resolveIdleStopMs(state);
  const context = createBrowserRouteContext({ getState: () => state });
  for (const runtime of state.profiles.values()) {
    const { profile } = runtime;
    // Attached browsers and visible desktop windows retain their external owner.
    if (
      !isLocalManagedProfile(profile) ||
      !runtime.running ||
      !(runtime.running.headless ?? profile.headless)
    ) {
      continue;
    }
    const lifecycle = getProfileLifecycle(runtime);
    if (lifecycle.leases.size > 0 || lifecycle.transitionReason) {
      continue;
    }
    const profileCtx = context.forProfile(profile.name);
    let stopIdleBrowser = false;
    try {
      await runProfileContextOperation(profileCtx, undefined, async (signal) => {
        const tabs = (await profileCtx.listTabs({ signal })).filter(
          (tab) => (tab.type ?? "page") === "page",
        );
        const currentTargets = new Set(tabs.map((tab) => tab.targetId));
        for (const targetId of lifecycle.tabLastUsedAt.keys()) {
          if (!currentTargets.has(targetId)) {
            lifecycle.tabLastUsedAt.delete(targetId);
          }
        }
        const now = Date.now();
        for (const tab of tabs) {
          // Restored pages and site-created tabs receive a full idle interval on discovery.
          if (!lifecycle.tabLastUsedAt.has(tab.targetId)) {
            lifecycle.tabLastUsedAt.set(tab.targetId, now);
          }
        }
        let blankTargetId = tabs.find((tab) => tab.url === "about:blank")?.targetId;
        let remainingPages = tabs.length;
        for (const tab of tabs) {
          if (tab.targetId === blankTargetId) {
            continue;
          }
          const lastUsed = lifecycle.tabLastUsedAt.get(tab.targetId)!;
          if (now - lastUsed < MANAGED_TAB_IDLE_MS) {
            continue;
          }
          // Keep Chromium and session cookies alive even when all real pages expire.
          // Open outside the dashboard close lane: registration takes that lane too.
          if (remainingPages === 1 && !blankTargetId && lifecycle.leases.size === 1) {
            blankTargetId = (await profileCtx.openTab("about:blank", { signal })).targetId;
            remainingPages += 1;
          }
          await dispatchBrowserTabClose(
            tab.targetId,
            profile.name,
            async () => {
              signal.throwIfAborted();
              // Check after dashboard admission too: a user action may have arrived
              // while the store or CDP list was pending. Never interrupt admitted work.
              if (
                lifecycle.leases.size !== 1 ||
                lifecycle.tabLastUsedAt.get(tab.targetId) !== lastUsed
              ) {
                return;
              }
              await fetchOk(
                appendCdpPath(
                  normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl),
                  `/json/close/${encodeURIComponent(tab.targetId)}`,
                ),
                state.resolved.remoteCdpTimeoutMs,
                { signal },
                resolveCdpControlPolicy(profile, state.resolved.ssrfPolicy),
              );
              lifecycle.tabLastUsedAt.delete(tab.targetId);
              remainingPages -= 1;
              if (runtime.lastTargetId === tab.targetId) {
                runtime.lastTargetId = null;
              }
            },
            { skipRetained: true },
          );
        }
        // Pages closed above left tabLastUsedAt; a retained dashboard page keeps
        // its entry and therefore keeps the browser. The stop clock starts when
        // the last page is gone and restarts on any recorded tab activity, so a
        // manual session that focused the blank page is respected.
        const openTabs = tabs.filter((tab) => lifecycle.tabLastUsedAt.has(tab.targetId));
        if (idleStopMs <= 0 || openTabs.some((tab) => tab.url !== "about:blank")) {
          lifecycle.pagesIdleSince = null;
        } else {
          lifecycle.pagesIdleSince ??= now;
          const idleSince = Math.max(
            lifecycle.pagesIdleSince,
            ...openTabs.map((tab) => lifecycle.tabLastUsedAt.get(tab.targetId)!),
          );
          stopIdleBrowser = now - idleSince >= idleStopMs;
        }
      });
    } catch {
      // Do not log URLs, page titles, or CDP errors containing owner data.
      onWarn("Could not reclaim idle managed browser tabs; will retry next sweep.");
      continue;
    }
    if (stopIdleBrowser) {
      await stopIdleManagedBrowser({ runtime, profileCtx, onWarn });
    }
  }
}
