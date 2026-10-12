import type {
  ExecutionOwnerBinding,
  ExecutionOwnerBindingResult,
} from "../../audit/execution-owner-binding.js";
import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import type {
  CronManagedFlowRepairInput,
  CronManagedFlowRepairOutput,
} from "./managed-flow-obligations.kernel.js";
import type { CronQuarantineRegistration } from "./quarantine.kernel.js";
import type { CronRunHistoryWorkerOperations } from "./run-history.types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import type { CronStoreSaveWorkerOperations } from "./save-worker.types.js";

export type CronStateWorkerOperations = CronRunHistoryWorkerOperations &
  CronStoreWorkerOperations &
  CronRuntimeWorkerOperations &
  CronStoreSaveWorkerOperations & {
    "cron.registerQuarantine": {
      input: CronQuarantineRegistration;
      output: void;
    };
    "cron.initializeRunReceipts": {
      input: Record<string, never>;
      output: void;
    };
    "cron.repairManagedFlowObligations": {
      input: CronManagedFlowRepairInput;
      output: CronManagedFlowRepairOutput;
    };
    "cron.bindReceiptExecution": {
      input: { handle: CronRunReceiptHandle; binding: ExecutionOwnerBinding };
      output: ExecutionOwnerBindingResult;
    };
  };
