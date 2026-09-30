import { projectMemoryArtifactSourceContent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { prepareMemoryIndexInWorker } from "./manager-cpu-worker-runtime.js";

/** Historical bytes stay on disk; only current regions reach the CPU/index worker. */
export async function prepareCurrentMemoryIndexInWorker(
  params: Parameters<typeof prepareMemoryIndexInWorker>[0] & { workspaceDir: string },
) {
  const { workspaceDir, ...request } = params;
  const projection =
    request.source === "memory"
      ? await projectMemoryArtifactSourceContent({
          workspaceDir,
          relativePath: request.entry.path,
          content: request.content,
        })
      : undefined;
  // Unknown authority retains storage and makes no deletion claim.
  if (projection?.status === "held") {
    return null;
  }
  return prepareMemoryIndexInWorker({
    ...request,
    content: projection?.content ?? request.content,
  });
}
