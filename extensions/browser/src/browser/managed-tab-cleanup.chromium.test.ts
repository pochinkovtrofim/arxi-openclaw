/** Explicit server integration proof using only a disposable Chromium profile and synthetic cookies. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { readManagedChromeHistory } from "./chrome-history.js";
import { stopOpenClawChrome, type RunningChrome } from "./chrome.js";
import { sweepIdleManagedBrowserTabs } from "./managed-tab-cleanup.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

it.skipIf(process.env.OPENCLAW_TEST_MANAGED_TAB_CHROMIUM !== "1")(
  "closes real pages and reopens history with persistent and session cookies in the same profile",
  async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "managed-tab-idle-"));
    const server = createServer((req, res) => {
      if (req.url === "/login") {
        res.setHeader("Set-Cookie", [
          "session=synthetic-session; HttpOnly; Path=/",
          "persistent=synthetic-persistent; Max-Age=3600; HttpOnly; Path=/",
        ]);
      }
      res.setHeader("Content-Type", "text/html");
      const authenticated =
        req.headers.cookie?.includes("session=synthetic-session") &&
        req.headers.cookie?.includes("persistent=synthetic-persistent");
      res.end(
        `<title>Idle cleanup fixture</title><p>${authenticated ? "authenticated" : "login"}</p><script>window.payload = new Uint8Array(64 * 1024 * 1024); window.payload.fill(42);</script>`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing fixture port");
    }
    const url = `http://127.0.0.1:${address.port}/login`;
    const proc = spawn(
      chromium.executablePath(),
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let chromiumStderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      chromiumStderr = (chromiumStderr + chunk).slice(-8_000);
    });
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    const realNow = Date.now.bind(Date);
    const running: RunningChrome = {
      pid: proc.pid!,
      proc,
      userDataDir,
      cdpPort: 0,
      startedAt: realNow(),
      exe: { kind: "chromium", path: chromium.executablePath() },
      headless: true,
    };
    try {
      let port = 0;
      await vi.waitFor(
        async () => {
          port = Number(
            (await readFile(path.join(userDataDir, "DevToolsActivePort"), "utf8")).split("\n")[0],
          );
          expect(port).toBeGreaterThan(0);
        },
        { timeout: 15_000 },
      );
      const profile = makeBrowserProfile({
        headless: true,
        cdpPort: port,
        cdpUrl: `http://127.0.0.1:${port}`,
      });
      const state = makeBrowserServerState({ profile });
      running.cdpPort = port;
      state.resolved.profiles.openclaw = { cdpPort: port, headless: true, color: profile.color };
      state.profiles.set("openclaw", {
        profile,
        running,
      });
      browser = await chromium.connectOverCDP(profile.cdpUrl);
      const browserContext = browser.contexts()[0]!;
      const control = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
      const opened = await control.openTab(url);
      await vi.waitFor(() =>
        expect(browserContext.pages().some((page) => page.url() === url)).toBe(true),
      );
      const page = browserContext.pages().find((entry) => entry.url() === url)!;
      await page.waitForLoadState();
      expect(await page.locator("p").textContent()).toBe("login");
      const warn = vi.fn();
      await sweepIdleManagedBrowserTabs(state, warn);
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60_000 + 1);
      await sweepIdleManagedBrowserTabs(state, warn);
      await vi.waitFor(() => expect(page.isClosed()).toBe(true));
      expect(await control.listTabs()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ targetId: opened.targetId })]),
      );
      expect(browserContext.pages().every((entry) => entry.url() === "about:blank")).toBe(true);
      vi.restoreAllMocks();
      await vi.waitFor(
        () => {
          expect(
            readManagedChromeHistory({ userDataDir, query: "/login" }).some(
              (entry) => entry.url === url,
            ),
          ).toBe(true);
        },
        { timeout: 15_000 },
      );
      const history = readManagedChromeHistory({ userDataDir, query: "/login" });
      await control.openTab(history[0]!.url);
      await vi.waitFor(() =>
        expect(browserContext.pages().some((entry) => entry.url() === url)).toBe(true),
      );
      const reopened = browserContext.pages().find((entry) => entry.url() === url)!;
      await reopened.waitForLoadState();
      expect(await reopened.locator("p").textContent()).toBe("authenticated");
      expect(warn).not.toHaveBeenCalled();
      console.info(
        "Chromium acceptance: idle page closed; history reopened; session and persistent cookies retained.",
      );
    } catch (error) {
      throw new Error(`Chromium idle cleanup acceptance failed: ${chromiumStderr}`, {
        cause: error,
      });
    } finally {
      vi.restoreAllMocks();
      await browser?.close();
      await stopOpenClawChrome(running);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
  60_000,
);
