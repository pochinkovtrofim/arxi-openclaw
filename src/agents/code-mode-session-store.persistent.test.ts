import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
} from "./code-mode-session-store.js";
import { SessionManager } from "./sessions/session-manager.js";
import { clearToolSearchCatalog } from "./tool-search-catalog.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";

const owners: ToolSearchCatalogRef[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const owner of owners.splice(0)) {
      clearToolSearchCatalog({ catalogRef: owner });
    }
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

function cell(manager: SessionManager) {
  const catalogRef: ToolSearchCatalogRef = {
    current: {
      entries: [],
      counterScope: "store-test",
      searchCount: 0,
      describeCount: 0,
      callCount: 0,
    },
  };
  owners.push(catalogRef);
  bindCodeModeSessionStore(catalogRef, manager);
  return createCodeModeSessionStoreAccess(
    { catalogRef, sessionId: manager.getSessionId(), runId: `run-${owners.length}` },
    new AbortController().signal,
  );
}

it("replays a stored session's active-branch values without hydrating its transcript", async () => {
  const dir = tempDirs.make("openclaw-code-mode-store-");
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  const target = {
    agentId: "main",
    sessionId: "store-session",
    sessionKey: "agent:main:store-session",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const manager = await SessionManager.openAsync(target, dir);
  const seed = cell(manager);
  await seed.save("inherited", "root", false);
  await seed.save("gone", "soon", false);
  await seed.commit();
  const root = manager.getLeafId()!;
  await manager.appendMessageAsync({ role: "user", content: "x".repeat(200_000), timestamp: 1 });
  const branchA = cell(manager);
  await branchA.save("branch", "A", false);
  await branchA.commit();
  await manager.branchAsync(root);
  const branchB = cell(manager);
  await branchB.save("branch", "B", true);
  await branchB.save("gone", undefined, false);
  await branchB.commit();

  const hydrate = vi.spyOn(SessionManager, "openAsync");
  const next = cell(manager);
  await expect(next.load("inherited")).resolves.toEqual({ value: "root", networkContent: false });
  await expect(next.load("branch")).resolves.toEqual({ value: "B", networkContent: true });
  await expect(next.load("gone")).resolves.toEqual({ networkContent: false });
  expect(hydrate).not.toHaveBeenCalled();
});
