import { log } from "../logger.js";

/** One line per attempt: how many images reached the harness, and from where. */
export function logAttemptImageMaterialization(
  params: {
    runId: string;
    images?: readonly unknown[];
    imageOrder?: readonly unknown[];
    media?: readonly unknown[];
    userTurnTranscriptRecorder?: unknown;
  },
  runtime: { agentHarness: { id: string }; effectiveModel: { input?: readonly string[] } },
  preparedImages: number,
): void {
  log.info("attempt image materialization", {
    runId: params.runId,
    harness: runtime.agentHarness.id,
    modelInput: runtime.effectiveModel.input,
    incomingImages: params.images?.length ?? 0,
    imageSlots: params.imageOrder?.length ?? 0,
    mediaFacts: params.media?.length ?? 0,
    recorder: Boolean(params.userTurnTranscriptRecorder),
    preparedImages,
  });
}
