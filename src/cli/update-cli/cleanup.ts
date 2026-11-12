/** Local recovery retirement. This handler never invokes update or Doctor repair. */
import { confirm } from "@clack/prompts";
import {
  inspectSessionSqliteRecovery,
  type RecoveryCleanupReport,
} from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "../../commands/doctor-session-sqlite-retirement.js";
import { readSourceConfigBestEffort } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { defaultRuntime, ExitError, writeRuntimeJson } from "../../runtime.js";
import { formatCliJsonFailure } from "../failure-output.js";
import { parseDurationMs } from "../parse-duration.js";
import { updateMaintenanceError } from "./update-maintenance-error.js";

type DoctorCopyRetirement = { retired: string[]; warnings: string[] };

/** Standalone Doctor captures and pre-repair cron backups made before `expiredBefore`. */
async function retireExpiredDoctorCopies(expiredBefore: number): Promise<DoctorCopyRetirement> {
  const [
    { withDoctorSqliteMaintenanceLock },
    { retireSupersededStandaloneDoctorCaptures },
    { retireSupersededCronDoctorBackups },
  ] = await Promise.all([
    import("../../commands/doctor-sqlite-maintenance-lock.js"),
    import("../../infra/update-recovery-baseline-capture.js"),
    import("../../commands/doctor/cron/store-repair.js"),
  ]);
  return withDoctorSqliteMaintenanceLock({
    env: process.env,
    operation: "update recovery cleanup",
    run: async (authority) => {
      const runStartedAtMs = Date.now();
      const assertCurrent = () => authority.assertCurrent();
      const captures = await retireSupersededStandaloneDoctorCaptures({
        stateDir: resolvePathViaExistingAncestorSync(resolveStateDir(process.env)),
        runStartedAtMs,
        assertCurrent,
        expiredBefore,
      });
      const cron = retireSupersededCronDoctorBackups({
        env: process.env,
        runStartedAtMs,
        assertCurrent,
        expiredBefore,
      });
      return {
        retired: [...captures.retired, ...cron.retired],
        warnings: [...captures.warnings, ...cron.warnings],
      };
    },
  });
}

function renderCleanup(report: RecoveryCleanupReport): void {
  defaultRuntime.log(`Recovery cleanup: ${report.stateDir}`);
  for (const item of report.artifacts) {
    defaultRuntime.log(
      `  ${item.outcome}: ${item.path} (${item.bytes} bytes; ${item.reason})${item.detail ? ` ${item.detail}` : ""}`,
    );
  }
  defaultRuntime.log(
    `Candidates: ${report.totals.candidateBytes} bytes; verification required: ${report.totals.verificationRequiredBytes}; protected: ${report.totals.protectedBytes}; blocked: ${report.totals.blockedBytes}.`,
  );
  const captures = report.artifacts.filter((item) => item.kind === "update-capture");
  if (captures.length > 0) {
    const sum = (outcome?: string) =>
      captures
        .filter((item) => outcome === undefined || item.outcome === outcome)
        .reduce((bytes, item) => bytes + item.bytes, 0);
    defaultRuntime.log(
      `Update captures: ${captures.length} (${sum()} bytes); candidates: ${sum("candidate")} bytes; protected: ${sum("protected")} bytes.`,
    );
  }
  defaultRuntime.log(
    "Retiring originals permanently loses rollback, including pre-repair branches and metadata. Logical bytes are not a promise of physical space reclaimed.",
  );
  if (report.artifacts.length === 0) {
    defaultRuntime.log("No recorded recovery artifacts found.");
  }
  if (report.status === "complete") {
    defaultRuntime.log(
      `Removed ${report.totals.removedFiles} files (${report.totals.removedBytes} logical bytes).`,
    );
  }
}

export async function updateCleanupCommand(options: {
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  olderThan?: string;
}): Promise<void> {
  let report: RecoveryCleanupReport | undefined;
  let doctorCopies: DoctorCopyRetirement | undefined;
  try {
    const expiredBefore =
      options.olderThan === undefined
        ? undefined
        : Date.now() - parseDurationMs(options.olderThan, { defaultUnit: "d" });
    report = inspectSessionSqliteRecovery({
      cfg: await readSourceConfigBestEffort(),
      env: process.env,
      expiredBefore,
    });
    if (!options.dryRun) {
      if (report.artifacts.length === 0 && !options.yes) {
        report.status = "complete";
      } else if (!options.yes && (options.json || !process.stdin.isTTY || !process.stderr.isTTY)) {
        report.status = "refused";
      } else {
        report = await retireSessionSqliteRecovery({
          env: process.env,
          expiredBefore,
          preview: report,
          readConfig: readSourceConfigBestEffort,
          confirm: async (verified) => {
            if (options.yes || verified.artifacts.length === 0) {
              return true;
            }
            renderCleanup(verified);
            const answer = await confirm({
              message: "Permanently retire these rollback originals?",
              initialValue: false,
              output: process.stderr,
            });
            return answer === true;
          },
        });
      }
    }
    if (expiredBefore !== undefined && !options.dryRun && options.yes) {
      doctorCopies = await retireExpiredDoctorCopies(expiredBefore);
    }
    if (options.json) {
      writeRuntimeJson(defaultRuntime, {
        ...report,
        ...(doctorCopies ? { doctorCopies } : {}),
        dryRun: options.dryRun === true,
      });
    } else {
      renderCleanup(report);
      for (const retired of doctorCopies?.retired ?? []) {
        defaultRuntime.log(`  removed Doctor copy: ${retired}`);
      }
      for (const warning of doctorCopies?.warnings ?? []) {
        defaultRuntime.log(`  ${warning}`);
      }
    }
    if (report.status === "refused") {
      defaultRuntime.error(
        "Nothing removed. Review with `openclaw update cleanup --dry-run`; use --yes to acknowledge permanent rollback loss.",
      );
      defaultRuntime.exit(1);
    } else if (report.status === "blocked") {
      defaultRuntime.exit(1);
    }
  } catch (error) {
    // Refusal and blocked outcomes were already rendered above.
    if (error instanceof ExitError) {
      throw error;
    }
    const message = String(updateMaintenanceError(error));
    if (options.json) {
      writeRuntimeJson(defaultRuntime, {
        ...report,
        ...(doctorCopies ? { doctorCopies } : {}),
        ...formatCliJsonFailure(message),
        status: "blocked",
      });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  }
}
