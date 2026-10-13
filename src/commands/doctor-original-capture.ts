import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  DoctorMaintenanceRefusalError,
  type UpdateDoctorWriteAuthority,
} from "../infra/update-doctor-result.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";

/** Preserve evidence before repair; neither a capture nor its lineage authorizes restoration. */
export async function preserveDoctorOriginalState(params: {
  root: string | null;
  env: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
  writeAuthority?: UpdateDoctorWriteAuthority;
  /** Receives the state directory whose capture root holds this run's capture. */
  onStandaloneCapture?: (stateDir: string) => void;
}): Promise<void> {
  const original = params.writeAuthority?.originalRecoveryCapture;
  const runId = original?.runId ?? params.env[UPDATE_RUN_ID_ENV]?.trim();
  const updateInProgress = original !== undefined || params.env.OPENCLAW_UPDATE_IN_PROGRESS === "1";
  const assertCallerCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    params.writeAuthority?.assertCurrent();
  };
  assertCallerCurrent();
  if (updateInProgress && !runId) {
    params.runtime.log(
      "Original update capture is unavailable. Doctor will repair current state without replacing the retained originals.",
    );
    return;
  }
  let admission: ReturnType<typeof resolveDoctorUpdateAdmission> | undefined;
  const assertCurrent = () => {
    assertCallerCurrent();
    admission?.assertCurrent();
  };
  try {
    // Older drivers may lack capture lineage; repair keeps its live maintenance and write authority.
    admission = updateInProgress
      ? resolveDoctorUpdateAdmission(params.env, original?.runId)
      : undefined;
    if (admission && runId) {
      const { readUpdateRecoveryBaselineIdentity } =
        await import("../infra/update-recovery-backup-reader.js");
      assertCurrent();
      const retained = await readUpdateRecoveryBaselineIdentity({
        runId,
        env: params.env,
        ...(original ? { ref: original.ref, installRoot: original.installRoot } : {}),
        readContinuation: admission.readContinuation,
        assertCurrent,
      });
      assertCurrent();
      params.runtime.log(
        retained
          ? `Original update capture retained at ${retained.ref.manifestPath}.`
          : "Original update capture is unavailable. Doctor will repair current state without replacing the retained originals.",
      );
      return;
    }
    const installRoot = params.root;
    if (!installRoot) {
      throw new Error("The installation could not be identified for the pre-repair capture.");
    }
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("The Doctor process could not be identified for the pre-repair capture.");
    }
    const { captureUpdateRecoveryBaseline } =
      await import("../infra/update-recovery-baseline-capture.js");
    assertCurrent();
    const standaloneRunId = `doctor-${randomUUID()}`;
    // Relocation can change the resolved state directory before Doctor completes.
    params.onStandaloneCapture?.(resolvePathViaExistingAncestorSync(resolveStateDir(params.env)));
    const captured = await captureUpdateRecoveryBaseline({
      runId: standaloneRunId,
      installRoot,
      env: params.env,
      drivers: [driver],
      assertCurrent,
      signal: params.signal,
      acquisition: { mode: "maintenance-owner" },
    });
    assertCurrent();
    params.runtime.log(
      `Pre-repair state retained for manual recovery at ${captured.ref.manifestPath}.`,
    );
    for (const warning of captured.warnings) {
      params.runtime.log(warning.message);
    }
    for (const warning of captured.diagnostics.databaseWarnings) {
      params.runtime.log(warning);
    }
  } catch (error) {
    assertCurrent();
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    if (original?.ref) {
      // An admitted baseline is part of this repair's contract, not optional
      // diagnostics. Never replace lost evidence with a capture of changed state.
      throw new DoctorMaintenanceRefusalError(
        `Doctor cannot verify its admitted original update capture: ${formatErrorMessage(error)}. State repair has not started. Inspect retained evidence with openclaw update status --json before retrying Doctor.`,
        { kind: "data-at-risk", reason: "unreadable-state" },
        { cause: error },
      );
    }
    params.runtime.log(
      `Original state capture was unavailable: ${formatErrorMessage(error)}. Doctor will continue; inspect retained evidence manually before restoring state.`,
    );
  }
}

/** Called only after Doctor verified the repaired state; the newest copies stay for rollback. */
export async function retireSupersededDoctorRecoveryCopies(params: {
  env: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  runStartedAtMs: number;
  /** State directories whose capture roots this run used, beside the current one. */
  captureStateDirs?: readonly string[];
}): Promise<void> {
  try {
    const [{ retireSupersededStandaloneDoctorCaptures }, { getOpenClawDatabaseMaintenanceScope }] =
      await Promise.all([
        import("../infra/update-recovery-baseline-capture.js"),
        import("../state/openclaw-state-db-async-lifecycle.js"),
      ]);
    const scope = getOpenClawDatabaseMaintenanceScope();
    if (!scope) {
      throw new Error("Doctor maintenance scope is unavailable.");
    }
    const retirement = { retired: [] as string[], warnings: [] as string[] };
    for (const stateDir of new Set([
      ...(params.captureStateDirs ?? []),
      resolvePathViaExistingAncestorSync(resolveStateDir(params.env)),
    ])) {
      const result = await retireSupersededStandaloneDoctorCaptures({
        stateDir,
        runStartedAtMs: params.runStartedAtMs,
        assertCurrent: () => scope.assertOwnerCurrent(),
      });
      retirement.retired.push(...result.retired);
      retirement.warnings.push(...result.warnings);
    }
    for (const directory of retirement.retired) {
      params.runtime.log(
        `Retired superseded Doctor capture: ${directory}. The newest sealed capture remains for manual recovery; take a verified backup when you need a long-term copy.`,
      );
    }
    const { retireSupersededCronDoctorBackups } = await import("./doctor/cron/store-repair.js");
    const cron = retireSupersededCronDoctorBackups({
      env: params.env,
      runStartedAtMs: params.runStartedAtMs,
      assertCurrent: () => scope.assertOwnerCurrent(),
    });
    for (const backupPath of cron.retired) {
      params.runtime.log(`Retired superseded pre-repair cron backup: ${backupPath}.`);
    }
    const { retireUnrecordedStartupMigrationBackups } =
      await import("./doctor-migration-backup-artifacts.js");
    const migration = retireUnrecordedStartupMigrationBackups({
      env: params.env,
      runStartedAtMs: params.runStartedAtMs,
      assertCurrent: () => scope.assertOwnerCurrent(),
    });
    for (const backupPath of migration.retired) {
      params.runtime.log(
        `Retired unrecorded pre-migration SQLite backup superseded by a verified migration: ${backupPath}.`,
      );
    }
    for (const warning of [...retirement.warnings, ...cron.warnings, ...migration.warnings]) {
      params.runtime.log(warning);
    }
  } catch (error) {
    params.runtime.log(
      `Superseded Doctor recovery copy retirement unavailable: ${formatErrorMessage(error)}`,
    );
  }
}
