import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionEndCause,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { CLAUDE_PROTOCOL_FIXTURE } from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();
export let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function createContext(
  scenario = "normal",
  overrides: Partial<CliBackendExecuteContext> = {},
  fixtureSource = CLAUDE_PROTOCOL_FIXTURE,
): Promise<CliBackendExecuteContext> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-protocol-")));
  roots.push(root);
  const fixture = path.join(root, "claude.mjs");
  await writeFile(
    fixture,
    `${fixtureReceiptClientSource(receipts.endpoint)}
${fixtureSource}`,
  );
  return {
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_FIXTURE_SCENARIO: scenario,
    },
    prompt: "synthetic user input",
    systemPrompt: "synthetic operator instructions",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    liveSession: createLiveSession(),
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(async () => ({
      behavior: "deny",
      message: "Fixture denied.",
    })),
    requestUserInput: vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
      status: "cancelled",
      message: "No question expected.",
    })),
    ...overrides,
  };
}

type FakeLiveSession = CliBackendLiveSessionCapability & {
  endCauses: (CliBackendLiveSessionEndCause | undefined)[];
  /** Whether the host would let the current process rescan its skills for this turn. */
  skillsOnlyChanged: boolean;
};

export function createLiveSession(cleanup?: () => Promise<void>): FakeLiveSession {
  let current: CliBackendLiveSessionHandle | undefined;
  let retiredCleanup: Promise<void> | undefined;
  const endCauses: (CliBackendLiveSessionEndCause | undefined)[] = [];
  const liveSession: FakeLiveSession = {
    endCauses,
    skillsOnlyChanged: false,
    fingerprint: "synthetic-process-policy",
    current: () => current,
    restart: async () => {
      const previous = current;
      previous?.close("restart");
      await previous?.waitForExit();
      await retiredCleanup;
    },
    register: (handle) => {
      if (retiredCleanup) {
        throw new Error("Previous CLI live session cleanup has not settled.");
      }
      current = handle;
      handles.add(handle);
    },
    activate: () => {},
    reloadSkills: async (handle, reload) => {
      if (!liveSession.skillsOnlyChanged || current !== handle) {
        return false;
      }
      try {
        await reload();
      } catch {
        return false;
      }
      handle.fingerprint = liveSession.fingerprint;
      return true;
    },
    remove: (handle, cause) => {
      if (current === handle) {
        current = undefined;
        endCauses.push(cause);
        if (cleanup) {
          retiredCleanup = handle
            .waitForExit()
            .then(cleanup)
            .then(() => {
              retiredCleanup = undefined;
            });
        }
      }
    },
  };
  return liveSession;
}

export async function collect(context: CliBackendExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(context)) {
    records.push(record);
  }
  return records;
}
