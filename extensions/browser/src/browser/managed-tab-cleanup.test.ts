import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdpHelpers from "./cdp.helpers.js";
import * as cdp from "./cdp.js";
import * as chrome from "./chrome.js";
import { sweepIdleManagedBrowserTabs } from "./managed-tab-cleanup.js";
import { createBrowserRouteContext, withProfileContextOperation } from "./server-context.js";
import { getProfileLifecycle } from "./server-context.lifecycle.js";
import {
  makeBrowserProfile,
  makeBrowserServerState,
  mockLaunchedChrome,
} from "./server-context.test-harness.js";
import * as sessionTabStore from "./session-tab-store.js";

const idleMs = 10 * 60_000;
let now: number;
let tabs: Array<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }>;
let state: ReturnType<typeof makeBrowserServerState>;
const warn = vi.fn();

function page(id: string, url = `https://example.test/${id}`) {
  return {
    id,
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:18800/devtools/page/${id}`,
  };
}

beforeEach(() => {
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  warn.mockReset();
  tabs = [page("old"), page("blank", "about:blank")];
  const profile = makeBrowserProfile({ headless: true });
  state = makeBrowserServerState({ profile });
  state.profiles.set(profile.name, {
    profile,
    running: mockLaunchedChrome({ mockResolvedValue: () => {} }, 123),
  });
  vi.spyOn(cdpHelpers, "fetchJson").mockImplementation(async (url) => {
    if (url.includes("/json/version")) {
      return { webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/browser/test" } as never;
    }
    return tabs as never;
  });
  vi.spyOn(cdpHelpers, "fetchOk").mockImplementation(async (url) => {
    const match = url.match(/\/json\/close\/(.+)$/);
    if (match) {
      tabs = tabs.filter((tab) => tab.id !== match[1]);
    }
  });
  vi.spyOn(cdp, "createTargetViaCdp").mockImplementation(async () => {
    tabs.push(page("replacement", "about:blank"));
    return { targetId: "replacement", finalUrl: "about:blank" };
  });
});

afterEach(() => vi.restoreAllMocks());

it("discovers restored pages, closes them after ten minutes, and keeps only one blank", async () => {
  tabs.push(page("extra-blank", "about:blank"));
  await sweepIdleManagedBrowserTabs(state, warn);
  now += idleMs - 1;
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs).toHaveLength(3);
  now += 1;
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs.map((tab) => tab.id)).toEqual(["blank"]);
  expect(getProfileLifecycle(state.profiles.get("openclaw")!).tabLastUsedAt.size).toBe(1);
  expect(warn).not.toHaveBeenCalled();
});

it("keeps Chromium alive by creating a blank before closing the last page", async () => {
  tabs = [page("old")];
  await sweepIdleManagedBrowserTabs(state, warn);
  now += idleMs;
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs.map((tab) => tab.id)).toEqual(["replacement"]);
  expect(cdp.createTargetViaCdp).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
});

it.each(["ensure", "focus"])(
  "extends the deadline after %s activity in the controller",
  async (action) => {
    await sweepIdleManagedBrowserTabs(state, warn);
    now += idleMs - 1;
    const profile = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
    if (action === "ensure") {
      await profile.ensureTabAvailable("old");
    } else {
      await profile.focusTab("old");
    }
    now += 1;
    await sweepIdleManagedBrowserTabs(state, warn);
    expect(tabs.some((tab) => tab.id === "old")).toBe(true);
    now += idleMs;
    await sweepIdleManagedBrowserTabs(state, warn);
    expect(tabs.map((tab) => tab.id)).toEqual(["blank"]);
  },
);

it("does not close tabs during an admitted profile operation", async () => {
  await sweepIdleManagedBrowserTabs(state, warn);
  now += idleMs;
  const profile = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
  await withProfileContextOperation(profile, undefined, async () => {
    await profile.ensureTabAvailable("old");
    now += idleMs;
    await sweepIdleManagedBrowserTabs(state, warn);
    expect(tabs).toHaveLength(2);
  });
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs).toHaveLength(2);
  now += idleMs;
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs.map((tab) => tab.id)).toEqual(["blank"]);
});

it("rechecks activity after awaiting close admission and preserves retained dashboards", async () => {
  tabs.push(page("dashboard"));
  await sweepIdleManagedBrowserTabs(state, warn);
  now += idleMs;
  const profile = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
  vi.spyOn(sessionTabStore, "dispatchBrowserTabClose").mockImplementation(
    async (id, _profile, close, options) => {
      expect(options?.skipRetained).toBe(true);
      if (id === "dashboard") {
        return undefined;
      }
      await profile.focusTab("old");
      return await close();
    },
  );
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs.map((tab) => tab.id)).toEqual(["old", "blank", "dashboard"]);
});

it("refreshes the long operation's own tab when another operation selects a different tab", async () => {
  tabs.push(page("other"));
  await sweepIdleManagedBrowserTabs(state, warn);
  const profile = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
  const admitted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const operation = withProfileContextOperation(profile, undefined, async () => {
    await profile.ensureTabAvailable("old");
    admitted.resolve();
    await finish.promise;
  });
  await admitted.promise;
  now += idleMs / 2;
  await profile.focusTab("other");
  now += idleMs / 2;
  finish.resolve();
  await operation;
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs.map((tab) => tab.id)).toEqual(["old", "blank", "other"]);
  now += idleMs / 2;
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs.map((tab) => tab.id)).toEqual(["old", "blank"]);
  now += idleMs / 2;
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs.map((tab) => tab.id)).toEqual(["blank"]);
});

it.each(["disabled", "visible", "attached", "external", "stopped"])(
  "leaves %s browsers alone",
  async (mode) => {
    const runtime = state.profiles.get("openclaw")!;
    if (mode === "disabled") {
      state.resolved.tabCleanup.enabled = false;
    }
    if (mode === "visible") {
      runtime.profile.headless = false;
    }
    if (mode === "attached") {
      runtime.profile.attachOnly = true;
    }
    if (mode === "external") {
      runtime.profile.cdpIsLoopback = false;
    }
    if (mode === "stopped") {
      runtime.running = null;
    }
    await sweepIdleManagedBrowserTabs(state, warn);
    now += idleMs;
    await sweepIdleManagedBrowserTabs(state, warn);
    expect(cdpHelpers.fetchJson).not.toHaveBeenCalled();
  },
);

it("retains a failed close for retry and reports no private URL", async () => {
  await sweepIdleManagedBrowserTabs(state, warn);
  now += idleMs;
  vi.mocked(cdpHelpers.fetchOk).mockRejectedValueOnce(new Error("https://private.test/path"));
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs).toHaveLength(2);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private.test");
  await sweepIdleManagedBrowserTabs(state, warn);
  expect(tabs.map((tab) => tab.id)).toEqual(["blank"]);
});

describe("idle process stop", () => {
  const stopMs = 15 * 60_000;

  function runtime() {
    return state.profiles.get("openclaw")!;
  }

  async function sweepFor(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 60_000) {
      now += Math.min(60_000, ms - elapsed);
      await sweepIdleManagedBrowserTabs(state, warn);
    }
  }

  beforeEach(() => {
    // vi.restoreAllMocks() leaves vi.mock() call history in place.
    vi.clearAllMocks();
    state.resolved.idleStopMinutes = 15;
    tabs = [page("blank", "about:blank")];
  });

  it("stops the browser through the stop lifecycle once no page has been open for idleStopMinutes", async () => {
    const running = runtime().running!;
    await sweepIdleManagedBrowserTabs(state, warn);
    await sweepFor(stopMs - 60_000);
    expect(runtime().running).toBe(running);
    await sweepFor(60_000);
    expect(runtime().running).toBeNull();
    expect(chrome.stopOpenClawChrome).toHaveBeenCalledWith(running);
    expect(chrome.stopOwnedOpenClawChrome).toHaveBeenCalledOnce();
    expect(cdpHelpers.fetchOk).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the browser resident by default", async () => {
    state.resolved.idleStopMinutes = 0;
    await sweepIdleManagedBrowserTabs(state, warn);
    await sweepFor(24 * 60 * 60_000);
    expect(runtime().running).not.toBeNull();
    expect(chrome.stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("starts the stop clock only after the last page tab is reclaimed", async () => {
    tabs = [page("old"), page("blank", "about:blank")];
    await sweepIdleManagedBrowserTabs(state, warn);
    await sweepFor(idleMs);
    expect(tabs.map((tab) => tab.id)).toEqual(["blank"]);
    await sweepFor(stopMs - 60_000);
    expect(runtime().running).not.toBeNull();
    await sweepFor(60_000);
    expect(runtime().running).toBeNull();
  });

  it("restarts the stop clock when the blank page is used, as a manual session does", async () => {
    await sweepIdleManagedBrowserTabs(state, warn);
    await sweepFor(stopMs - 60_000);
    const profile = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
    await profile.focusTab("blank");
    await sweepFor(stopMs - 60_000);
    expect(runtime().running).not.toBeNull();
    await sweepFor(60_000);
    expect(runtime().running).toBeNull();
  });

  it("defers the stop while a profile operation is admitted", async () => {
    await sweepIdleManagedBrowserTabs(state, warn);
    const profile = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
    await withProfileContextOperation(profile, undefined, async () => {
      await sweepFor(2 * stopMs);
      expect(runtime().running).not.toBeNull();
    });
    expect(runtime().running).not.toBeNull();
    await sweepFor(stopMs);
    expect(runtime().running).toBeNull();
  });

  it("keeps a browser whose only page is retained by a dashboard", async () => {
    tabs.push(page("dashboard"));
    vi.spyOn(sessionTabStore, "dispatchBrowserTabClose").mockImplementation(
      async (id, _profile, close) => (id === "dashboard" ? undefined : await close()),
    );
    await sweepIdleManagedBrowserTabs(state, warn);
    await sweepFor(idleMs + 2 * stopMs);
    expect(tabs.map((tab) => tab.id)).toEqual(["blank", "dashboard"]);
    expect(runtime().running).not.toBeNull();
  });

  it("lets an action that arrives during the idle stop wait and relaunch", async () => {
    await sweepIdleManagedBrowserTabs(state, warn);
    const stopEntered = Promise.withResolvers<void>();
    const stopReleased = Promise.withResolvers<void>();
    vi.mocked(chrome.stopOpenClawChrome).mockImplementationOnce(async () => {
      stopEntered.resolve();
      await stopReleased.promise;
    });
    const relaunched = mockLaunchedChrome(vi.mocked(chrome.launchOpenClawChrome), 789);
    vi.mocked(chrome.isChromeReachable).mockResolvedValue(false);
    vi.mocked(chrome.isChromeCdpReady).mockResolvedValue(true);
    const sweeps = sweepFor(stopMs);
    await stopEntered.promise;
    const profile = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
    const action = profile.ensureBrowserAvailable();
    expect(chrome.launchOpenClawChrome).not.toHaveBeenCalled();
    stopReleased.resolve();
    await sweeps;
    await expect(action).resolves.toBeUndefined();
    expect(chrome.launchOpenClawChrome).toHaveBeenCalledOnce();
    expect(runtime().running).toBe(relaunched);
    expect(warn).not.toHaveBeenCalled();
    vi.mocked(chrome.isChromeReachable).mockResolvedValue(true);
  });

  it("relaunches the browser on the next action after an idle stop", async () => {
    await sweepIdleManagedBrowserTabs(state, warn);
    await sweepFor(stopMs);
    expect(runtime().running).toBeNull();
    const relaunched = mockLaunchedChrome(vi.mocked(chrome.launchOpenClawChrome), 456);
    vi.mocked(chrome.isChromeReachable).mockResolvedValue(false);
    vi.mocked(chrome.isChromeCdpReady).mockResolvedValue(true);
    const profile = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
    await profile.ensureBrowserAvailable();
    expect(chrome.launchOpenClawChrome).toHaveBeenCalledOnce();
    expect(runtime().running).toBe(relaunched);
    // The restored blank page gets a fresh window from its discovery sweep.
    tabs = [page("blank-2", "about:blank")];
    await sweepIdleManagedBrowserTabs(state, warn);
    await sweepFor(stopMs - 60_000);
    expect(runtime().running).toBe(relaunched);
    await sweepFor(60_000);
    expect(runtime().running).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    vi.mocked(chrome.isChromeReachable).mockResolvedValue(true);
  });
});
