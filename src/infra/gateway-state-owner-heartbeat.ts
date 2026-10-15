import fs from "node:fs";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  getGatewaySuspendAdmissionPhase,
  onGatewaySuspendAdmissionChange,
} from "../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { GATEWAY_OWNER_HEARTBEAT_MS } from "./gateway-lock-payload.js";
import {
  GATEWAY_HOST_SUSPENSION_PREPARED,
  GATEWAY_HOST_SUSPENSION_RESUMED,
  readGatewayHostSuspension,
  type GatewayStateOwnerHeartbeatData,
} from "./gateway-state-owner-heartbeat.runtime.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "./runtime-worker-url.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";

const now = Date.now.bind(Date);

/** Process and schema owners share one renewal worker and one failure deadline. */
export function startGatewayStateOwnerHeartbeat(
  heldLocks: Iterable<{ lockPath: string; verifyStillHeld(): boolean }>,
  onLost: (error: Error) => void,
) {
  const locks: Record<string, string> = {};
  for (const lock of heldLocks) {
    locks[lock.lockPath] = fs.readFileSync(lock.lockPath, "utf8");
    if (!lock.verifyStillHeld()) {
      throw new Error("OpenClaw state ownership is no longer current");
    }
  }
  return runInDetachedAsyncContext(() => {
    const lastBeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
    // Match the lock's mtime clock; Bun workers have independent hrtime origins.
    Atomics.store(lastBeat, 0, BigInt(now()));
    // The host may pause the VM only after admission reaches prepared, then steps
    // the guest wall clock after resume. Neither gap counts against custody; a
    // missed renewal observed across them gets one monotonic failure budget.
    const hostSuspension = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let resumedAt: number | undefined;
    let graceFrom: number | undefined;
    const followSuspension = (phase: ReturnType<typeof getGatewaySuspendAdmissionPhase>) => {
      if (phase === "prepared") {
        Atomics.store(hostSuspension, 0, GATEWAY_HOST_SUSPENSION_PREPARED);
        resumedAt = undefined;
      } else if (readGatewayHostSuspension(hostSuspension) === GATEWAY_HOST_SUSPENSION_PREPARED) {
        Atomics.store(hostSuspension, 0, GATEWAY_HOST_SUSPENSION_RESUMED);
        resumedAt = performance.now();
      }
    };
    followSuspension(getGatewaySuspendAdmissionPhase());
    const unsubscribe = onGatewaySuspendAdmissionChange(followSuspension);
    const { port1, port2 } = new MessageChannel();
    const url = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.gatewayStateOwnerHeartbeat);
    const worker = createCpuTrackedWorker(url, {
      workerData: {
        locks,
        intervalMs: GATEWAY_OWNER_HEARTBEAT_MS,
        failureMs: 60_000,
        lastBeat: lastBeat.buffer,
        hostSuspension: hostSuspension.buffer,
        events: port2,
      } satisfies GatewayStateOwnerHeartbeatData,
      transferList: [port2],
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    });
    worker.unref();
    port1.unref();
    let failure: string | null = null;
    worker.on("error", (error) => {
      failure = coerceErrorMessage(error);
    });
    const inspect = () => {
      // Drain diagnostics synchronously when native work resumes before port callbacks.
      let message;
      while ((message = receiveMessageOnPort(port1))) {
        failure = message.message;
      }
      const suspension = readGatewayHostSuspension(hostSuspension);
      const renewedAt = Atomics.load(lastBeat, 0);
      // Sample after loading the beat so concurrent renewal cannot appear to be in the future.
      const age = now() - Number(renewedAt);
      const monotonic = performance.now();
      const resumedRecently = resumedAt !== undefined && monotonic - resumedAt < 60_000;
      let remaining = age < 0 ? 0 : 60_000 - age;
      if (remaining > 0) {
        graceFrom = undefined;
        if (suspension === GATEWAY_HOST_SUSPENSION_RESUMED && !resumedRecently) {
          Atomics.store(hostSuspension, 0, 0);
          resumedAt = undefined;
        }
      } else if (
        age >= 0 &&
        (graceFrom !== undefined ||
          suspension === GATEWAY_HOST_SUSPENSION_PREPARED ||
          resumedRecently)
      ) {
        graceFrom ??= monotonic;
        remaining = 60_000 - (monotonic - graceFrom);
      }
      if (remaining <= 0) {
        onLost(
          new Error(
            `Gateway state ownership is no longer current at ${Object.keys(locks)[0]}: ${failure ?? (age < 0 ? "heartbeat clock moved backwards" : "utimes heartbeat renewal did not complete within 60 seconds")}; restart the Gateway.`,
          ),
        );
      }
      return remaining;
    };
    let timer: ReturnType<typeof setTimeout>;
    const watch = () => {
      const remaining = inspect();
      if (remaining > 0) {
        timer = setTimeout(watch, remaining);
        timer.unref();
      }
    };
    watch();
    return {
      worker,
      paths: new Set(Object.keys(locks)),
      inspect,
      stop() {
        unsubscribe();
        clearTimeout(timer);
        port1.close();
        worker.postMessage("stop", []);
        void worker.terminate();
      },
    };
  });
}
