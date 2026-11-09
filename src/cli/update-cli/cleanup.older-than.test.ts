import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseUpdateRecoveryBackupManifest } from "../../commands/backup-verify-manifest.js";
import { resolveUpdateCaptureRoot } from "../../infra/update-capture-paths.js";
import { defaultRuntime } from "../../runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { updateCleanupCommand } from "./cleanup.js";

afterEach(() => vi.restoreAllMocks());

it("--older-than retires a week-old Doctor capture and cron backup through the command", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const day = 24 * 60 * 60_000;
    const capture = async (ageDays: number) => {
      const runId = `doctor-${randomUUID()}`;
      const directory = path.join(resolveUpdateCaptureRoot(state.stateDir), runId);
      const manifest = JSON.stringify({
        schemaVersion: 2,
        kind: "update-recovery",
        generation: { kind: "baseline" },
        databases: [],
        runId,
        installRoot: state.root,
        stateDir: state.stateDir,
        configPath: state.configPath,
        configPaths: [state.configPath],
        creator: { host: "fixture", pid: 1, startIdentity: "1" },
        drivers: [],
        createdAt: new Date(Date.now() - ageDays * day).toISOString(),
        roots: [state.configPath],
        excludedRoots: [],
        protectedPaths: [state.configPath],
        entries: [
          { kind: "missing", sourcePath: state.configPath, sqlite: false, directory: false },
        ],
      });
      parseUpdateRecoveryBackupManifest(manifest);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "manifest.json"), manifest);
      return directory;
    };
    // The newest copies, which only the age releases.
    const oldCapture = await capture(8);
    const databasePath = openOpenClawStateDatabase().path;
    const oldCron = `${databasePath}.doctor-cron-${Date.now() - 8 * day}-${randomUUID()}.bak`;
    await fs.writeFile(oldCron, "earlier backup");
    const output: unknown[] = [];
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
      output.push(value);
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await updateCleanupCommand({ json: true, yes: true, olderThan: "9d" });
    expect(output.at(-1)).toMatchObject({ doctorCopies: { retired: [], warnings: [] } });

    await updateCleanupCommand({ json: true, yes: true, olderThan: "7d" });
    const result = output.at(-1) as {
      status: string;
      doctorCopies: { retired: string[]; warnings: string[] };
    };
    expect(result.status).toBe("complete");
    expect(result.doctorCopies.warnings).toEqual([]);
    expect(result.doctorCopies.retired.map((file) => path.basename(file))).toEqual(
      [oldCapture, oldCron].map((file) => path.basename(file)),
    );
    await expect(fs.lstat(oldCapture)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(oldCron)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
