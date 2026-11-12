// Unified approval handlers test safe projections, authorization, and one-shot resolution.
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateApprovalResolveResult } from "../../../packages/gateway-protocol/src/index.js";
import { installTestApprovalClock } from "../exec-approval-manager.test-support.js";
import * as operatorApprovalStore from "../operator-approval-store.js";
import {
  cleanupApprovalHandlerFixtures,
  createClient,
  createHandlers,
  createDatabaseOptions,
  createManagers,
  getOperatorApproval,
  invoke,
  registerExec,
  registerPlugin,
} from "./approval.handlers.test-support.js";
import { createApprovalHandlers } from "./approval.js";
import { createContext } from "./approval.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const prepareApprovalChannelCustodyMock = vi.hoisted(() => vi.fn());

// mock-isolation: Approval fixtures control custody and config revocation without loading channel runtimes.
vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: (...args: unknown[]) => {
    const custody = prepareApprovalChannelCustodyMock(...args);
    return (
      custody && {
        ...custody,
        isCurrent:
          custody.isCurrent ??
          ((request: unknown) => {
            const input = args[0] as { cfg: unknown; getCfg?: () => unknown };
            return (!input.getCfg || input.getCfg() === input.cfg) && custody.authorizes(request);
          }),
        [Symbol.dispose]() {},
      }
    );
  },
}));
describe("unified approval handlers", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupApprovalHandlerFixtures();
  });
  it("uses the live requester connection when filtering legacy resolved events", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, {
      id: "device-less-requester",
      reviewerDeviceIds: ["reviewer-device"],
      requester: {
        connId: "requester-connection",
        deviceId: null,
        clientId: "requester-client",
      },
    });
    const context = createContext();
    const handlers = createHandlers(managers, databaseOptions);

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer-device" }),
      context,
    });

    expect(response.result).toMatchObject({ applied: true, approval: { status: "denied" } });
    const recipientLookup = context.getApprovalClientConnIds as ReturnType<typeof vi.fn>;
    const recipientOptions = recipientLookup.mock.calls[0]?.[0] as
      | {
          approvalKind?: string;
          filter?: (
            client: GatewayRequestHandlerOptions["client"],
            record?: { requestedByConnId?: string | null },
          ) => boolean;
          record?: { requestedByConnId?: string | null };
        }
      | undefined;
    expect(recipientOptions?.approvalKind).toBe("exec");
    expect(recipientOptions?.record?.requestedByConnId).toBe("requester-connection");
    expect(
      recipientOptions?.filter?.(
        createClient({ connId: "requester-connection" }),
        recipientOptions.record,
      ),
    ).toBe(true);
    expect(
      recipientOptions?.filter?.(
        createClient({ connId: "unrelated-connection" }),
        recipientOptions.record,
      ),
    ).toBe(false);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("returns the recorded winner to a competing surface without rebroadcasting", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, {
      id: "first-answer-wins",
      reviewerDeviceIds: ["control-ui", "telegram"],
    });
    const context = createContext();
    const handlers = createHandlers(managers, databaseOptions);

    const [first, second] = await Promise.all([
      invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision: "allow-once" },
        client: createClient({ deviceId: "control-ui" }),
        context,
      }),
      invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision: "deny" },
        client: createClient({ deviceId: "telegram" }),
        context,
      }),
    ]);
    expect([first.result, second.result]).toEqual([
      expect.objectContaining({
        applied: true,
        approval: expect.objectContaining({ status: "allowed", decision: "allow-once" }),
      }),
      expect.objectContaining({
        applied: false,
        approval: expect.objectContaining({ status: "allowed", decision: "allow-once" }),
      }),
    ]);
    expect(validateApprovalResolveResult(first.result)).toBe(true);
    expect(validateApprovalResolveResult(second.result)).toBe(true);
    await expect(pending.decision).resolves.toBe("allow-once");
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("resolves through the durable transport ref exactly like the canonical id", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    // No explicit reviewer binding: any authorized reviewer device may resolve,
    // and the opaque transport ref must behave exactly like the canonical id.
    const pending = await registerExec(managers.exec, {
      id: `approval-${"a".repeat(119)}`,
      requester: { connId: "conn-owner", deviceId: null, clientId: null },
      reviewerDeviceIds: [],
    });
    const durable = await getOperatorApproval({ id: pending.record.id, databaseOptions });
    expect(durable?.resolutionRef).toHaveLength(43);
    const handlers = createHandlers(managers, databaseOptions);

    const winner = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: durable?.resolutionRef, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer-surface" }),
    });
    expect(winner.result).toMatchObject({
      applied: true,
      approval: { id: pending.record.id, status: "denied", decision: "deny" },
    });
    await expect(pending.decision).resolves.toBe("deny");

    const replayByCanonicalId = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "another-surface" }),
    });
    expect(replayByCanonicalId.result).toMatchObject({
      applied: false,
      approval: { id: pending.record.id, status: "denied", decision: "deny" },
    });
  });
  it.each([
    { status: "allowed", decision: "allow-once", terminalDecision: "allow-once" },
    { status: "expired", decision: "allow-once", terminalDecision: null },
  ] as const)(
    "returns retained $status truth after the process-local waiter is gone",
    async ({ status, decision, terminalDecision }) => {
      const databaseOptions = createDatabaseOptions();
      const managers = createManagers(databaseOptions);
      const pending = await registerExec(managers.exec, {
        id: `terminal-after-restart-${status}`,
        reviewerDeviceIds: ["later-surface"],
      });
      if (status === "allowed") {
        await managers.exec.resolveDetailed(pending.record.id, terminalDecision, {
          kind: "device",
          id: "first-surface",
        });
      } else {
        await managers.exec.forceDenyDetailed(
          pending.record.id,
          "timeout",
          { kind: "system", id: null },
          status,
          null,
        );
      }
      await expect(pending.decision).resolves.toBe(terminalDecision);

      const restartedManagers = createManagers(databaseOptions);
      const context = createContext();
      const handlers = createApprovalHandlers({
        execApprovalManager: restartedManagers.exec,
        pluginApprovalManager: restartedManagers.plugin,
        databaseOptions,
      });
      const response = await invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision },
        client: createClient({ deviceId: "later-surface" }),
        context,
      });

      expect(response.result).toMatchObject({
        applied: false,
        approval: {
          status,
        },
      });
      expect(validateApprovalResolveResult(response.result)).toBe(true);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("atomically denies malformed, mismatched-kind, and disallowed approving verdicts", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const disallowed = await registerExec(managers.exec, {
      id: "disallowed-allow-always",
      request: { unavailableDecisions: ["allow-always"] },
    });
    const malformed = await registerPlugin(managers.plugin, {
      id: "plugin:malformed",
      request: { allowedDecisions: ["allow-once"] },
    });
    const mismatchedKind = await registerPlugin(managers.plugin, {
      id: "opaque-plugin-id",
      request: { allowedDecisions: ["allow-once"] },
    });
    const handlers = createHandlers(managers, databaseOptions);
    const client = createClient({ deviceId: "reviewer" });

    const disallowedResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: disallowed.record.id, kind: "exec", decision: "allow-always" },
      client,
    });
    expect(disallowedResponse.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "malformed-verdict" },
    });
    await expect(disallowed.decision).resolves.toBe("deny");

    const malformedResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: malformed.record.id, kind: "plugin", decision: "ACCEPT" },
      client,
    });
    expect(malformedResponse.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "malformed-verdict" },
    });
    await expect(malformed.decision).resolves.toBe("deny");

    const mismatchedKindResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: mismatchedKind.record.id, kind: "exec", decision: "allow-once" },
      client,
    });
    expect(mismatchedKindResponse.result).toMatchObject({
      applied: true,
      approval: {
        status: "denied",
        decision: "deny",
        reason: "malformed-verdict",
        presentation: { kind: "plugin" },
      },
    });
    await expect(mismatchedKind.decision).resolves.toBe("deny");
  });

  it("lets the exact deadline beat a malformed verdict", async () => {
    installTestApprovalClock();
    const get = operatorApprovalStore.getOperatorApprovalDetailed;
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockImplementation((params) =>
      get({ ...params, nowMs: Date.now() }),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, {
      id: "malformed-at-deadline",
      expiresAtMs: 2_000,
    });
    const context = createContext();
    const handlers = createHandlers(managers, databaseOptions);
    // The lookup observes pending immediately before the deadline; force-deny's
    // store transaction reaches the exact deadline and must reconcile expiry.
    now.mockReturnValueOnce(1_999).mockReturnValue(2_000);

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "ACCEPT" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.result).toMatchObject({
      applied: false,
      approval: {
        status: "expired",
        reason: "timeout",
        resolvedAtMs: 2_000,
      },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBeNull();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });
});
