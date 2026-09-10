/** Browser-history route for an OpenClaw-managed Chromium profile. */
import {
  mergeManagedChromeHistory,
  readManagedChromeHistory,
  readManagedChromeLiveHistory,
  type BrowserHistoryEntry,
} from "../chrome-history.js";
import { resolveOpenClawUserDataDir } from "../chrome.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { getPwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext } from "../server-context.js";
import { resolveProfileContext } from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

/** Register the read-only managed-browser history endpoint. */
export function registerBrowserHistoryRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  app.get("/history", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
    if (capabilities.mode !== "local-managed" || !capabilities.browserFilesystemLocal) {
      jsonError(
        res,
        400,
        "browser history is only available for OpenClaw-managed browser profiles",
      );
      return;
    }
    try {
      const rawLimit = toStringOrEmpty(req.query.limit);
      if (rawLimit && !/^[1-9][0-9]*$/u.test(rawLimit)) {
        jsonError(res, 400, "limit must be a positive integer");
        return;
      }
      const limit = rawLimit ? Number(rawLimit) : undefined;
      if (limit !== undefined && !Number.isSafeInteger(limit)) {
        jsonError(res, 400, "limit must be a positive integer");
        return;
      }
      const query = toStringOrEmpty(req.query.query) || undefined;
      let persisted: BrowserHistoryEntry[] | undefined;
      try {
        persisted = readManagedChromeHistory({
          userDataDir: resolveOpenClawUserDataDir(profileCtx.profile.name),
          query,
          limit,
        });
      } catch {}
      let live: BrowserHistoryEntry[] | undefined;
      try {
        const pw = await getPwAiModule();
        if (pw) {
          live = await readManagedChromeLiveHistory({ profileCtx, pw });
        }
      } catch {}
      if (!persisted && !live) {
        throw new Error("no browser history source is available");
      }
      res.json({
        entries: mergeManagedChromeHistory({
          persisted: persisted ?? [],
          live: live ?? [],
          query,
          limit,
        }),
      });
    } catch {
      jsonError(
        res,
        500,
        "browser history is unavailable; start the managed browser and browse a page before retrying",
      );
    }
  });
}
