import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import {
  createMemoryWriteProvenanceObserver,
  type MemoryWriteProvenanceObserver,
} from "./memory-write-provenance.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export function createToolMemoryWriteProvenance(params: {
  options?: OpenClawCodingToolsOptions;
  sandboxRoot?: string;
  workspaceRoot: string;
  sandboxFsBridge?: SandboxFsBridge;
}) {
  const { options, sandboxRoot, workspaceRoot, sandboxFsBridge } = params;
  return createMemoryWriteProvenanceObserver({
    mutationRoot: sandboxRoot ?? workspaceRoot,
    workspaceDir: sandboxRoot ?? workspaceRoot,
    resolvePath: sandboxFsBridge
      ? (filePath) =>
          resolveSandboxFileIdentity({
            bridge: sandboxFsBridge,
            filePath,
            cwd: sandboxRoot,
            signal: options?.abortSignal,
          })
      : undefined,
    resolveOriginClass: () =>
      options?.senderIsOwner === false || options?.isTurnTainted?.() === true
        ? "untrusted"
        : "agent",
    sessionId: options?.sessionId,
    sessionKey: options?.runSessionKey ?? options?.sessionKey,
    runId: options?.runId,
    abortSignal: options?.abortSignal,
  });
}

export function createMemoryReadProjection(params: {
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
}) {
  return params.memoryWriteProvenance?.read
    ? async (filePath: string, buffer: Buffer) =>
        (await params.memoryWriteProvenance!.classifies(filePath))
          ? Buffer.from(
              await params.memoryWriteProvenance!.read!(filePath, buffer.toString("utf8")),
              "utf8",
            )
          : buffer
    : undefined;
}
