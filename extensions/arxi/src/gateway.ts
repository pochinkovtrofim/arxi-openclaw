import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createChannelIngressMonitor } from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { acceptInbound, pollInbound } from "./bridge.js";
import { dispatchArxiInbound, prepareArxiInbound, type StoredArxiInbound } from "./inbound.js";
import { getArxiRuntime } from "./runtime.js";

type ArxiAccount = { accountId: string; enabled: boolean; configured: boolean };

export async function startArxiGateway(ctx: ChannelGatewayContext<ArxiAccount>) {
  const runtime = getArxiRuntime();
  const monitor = createChannelIngressMonitor<
    StoredArxiInbound,
    StoredArxiInbound,
    StoredArxiInbound
  >({
    queue: () => runtime.state.openChannelIngressQueue<StoredArxiInbound>({ accountId: "default" }),
    inspect: (event) => ({ eventId: event.event_id, laneKey: `direct:${event.conversation_id}` }),
    payload: {
      version: 1,
      serialize: (event) => event,
      deserialize: (event) => event,
      encode: ({ body }) => body,
      decode: (payload) => ({ version: payload.version, body: payload }),
      createClaimError: (_kind, claim) => new Error(`Arxi ingress row ${claim.id} is invalid`),
    },
    deliver: async (event, lifecycle) => {
      await dispatchArxiInbound({
        cfg: ctx.cfg,
        runtime,
        event,
        lifecycle,
      });
      await acceptInbound(event);
    },
    retention: { completedMaxEntries: 2_000, failedMaxEntries: 2_000 },
    pollIntervalMs: 500,
    createStoppedError: () => new Error("Arxi ingress is stopped"),
    onError: (error) => ctx.log?.error?.(`Arxi ingress failed: ${String(error)}`),
  });
  monitor.start();
  ctx.setStatus(channelReadyPatch({ accountId: "default" }));
  try {
    while (!ctx.abortSignal.aborted) {
      const event = await pollInbound(ctx.abortSignal);
      if (!event) {
        continue;
      }
      const prepared = await prepareArxiInbound(event);
      const admitted = await monitor.admit(prepared, { receivedAt: Date.now() });
      if (admitted.kind === "durable" && admitted.queueResult.kind === "completed") {
        await acceptInbound(event, ctx.abortSignal);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
  } finally {
    await monitor.stop();
    ctx.setStatus(channelStoppedPatch({ accountId: "default" }));
  }
}
