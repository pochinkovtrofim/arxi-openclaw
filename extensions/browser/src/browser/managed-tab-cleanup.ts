/** Reclaim idle pages in locally owned headless browsers without deleting their profile. */
import { resolveCdpControlPolicy } from "./cdp-reachability-policy.js";
import { fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { isLocalManagedProfile } from "./config.js";
import { createBrowserRouteContext, runProfileContextOperation } from "./server-context.js";
import { getProfileLifecycle, isBrowserRuntimeRunning } from "./server-context.lifecycle.js";
import type { BrowserServerState } from "./server-context.types.js";
import { dispatchBrowserTabClose } from "./session-tab-store.js";

const MANAGED_TAB_IDLE_MS = 10 * 60_000;

export async function sweepIdleManagedBrowserTabs(
  state: BrowserServerState,
  onWarn: (message: string) => void,
): Promise<void> {
  if (!isBrowserRuntimeRunning(state) || !state.resolved.tabCleanup.enabled) {
    return;
  }
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
      });
    } catch {
      // Do not log URLs, page titles, or CDP errors containing owner data.
      onWarn("Could not reclaim idle managed browser tabs; will retry next sweep.");
    }
  }
}
