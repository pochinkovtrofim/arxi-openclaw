import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import {
  createExpiredOauthStore,
  resetOAuthProviderRuntimeMocks,
  resolveApiKeyForProfileInTest,
} from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";

const mocks = getOAuthProviderRuntimeMocks();
const { refreshProviderOAuthCredentialWithPluginMock } = mocks;
const profileId = "openai:default";
const provider = "openai";

// mock-isolation: Synthetic credentials must not enter real provider discovery or network OAuth.
vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

beforeEach(async () => {
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks(mocks);
  clearRuntimeAuthProfileStoreSnapshots();
  const { resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js");
  resetOAuthRefreshQueuesForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks(mocks);
  clearRuntimeAuthProfileStoreSnapshots();
});

it.each(["flushed", "flush fails"] as const)(
  "a rotated refresh token is flushed to disk before use (%s)",
  async (outcome) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "oauth-refresh-durability" },
      async (state) => {
        const [sqliteFiles, { resolveApiKeyForProfile }] = await Promise.all([
          import("../../infra/sqlite-files.js"),
          import("./oauth.js"),
        ]);
        const agentDir = state.agentDir();
        saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), agentDir);
        const replacement = {
          type: "oauth" as const,
          provider,
          access: "synthetic-rotated-access",
          refresh: "synthetic-rotated-refresh",
          expires: Date.now() + 60 * 60 * 1000,
        };
        refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(replacement);
        const sync = sqliteFiles.syncSqliteDatabaseFiles;
        const flushed: string[] = [];
        vi.spyOn(sqliteFiles, "syncSqliteDatabaseFiles").mockImplementation(async (pathname) => {
          flushed.push(pathname);
          if (outcome === "flush fails") {
            throw new Error("synthetic EIO");
          }
          await sync(pathname);
        });

        const resolved = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(agentDir),
          profileId,
          agentDir,
        });

        expect(resolved?.apiKey).toBe(replacement.access);
        expect(flushed).toEqual([resolveAuthProfileDatabasePath(agentDir)]);
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toMatchObject(
          replacement,
        );
      },
    );
  },
);
