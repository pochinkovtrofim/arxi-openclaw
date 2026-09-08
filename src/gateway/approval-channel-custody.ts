import type { ApprovalChannelReviewer } from "../../packages/gateway-protocol/src/index.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  doesApprovalRequestSelectChannelAccount,
  type ApprovalRequestLike,
} from "../infra/approval-request-account-binding.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";

type PreparedApprovalChannelCustody = {
  resolverId: string;
  authorizes: (
    request: ApprovalRequestLike,
    target?: { approvalId: string; decision: ExecApprovalDecision },
    resolutionProof?: string,
  ) => boolean;
};

export function prepareApprovalChannelCustody(params: {
  cfg: OpenClawConfig;
  approvalKind: ChannelApprovalKind;
  reviewer: ApprovalChannelReviewer;
}): PreparedApprovalChannelCustody | null {
  const channel = params.reviewer.channel.trim().toLowerCase();
  const accountId = params.reviewer.accountId.trim();
  const senderId = params.reviewer.senderId.trim();
  if (!channel || !accountId || !senderId) {
    return null;
  }
  const plugin = getLoadedChannelPlugin(channel);
  const capability = resolveChannelApprovalCapability(plugin);
  const authorizeActorAction = capability?.authorizeActorAction;
  if (!plugin || !authorizeActorAction) {
    return null;
  }
  const isActorAuthorized = (candidateAccountId: string) =>
    authorizeActorAction({
      cfg: params.cfg,
      accountId: candidateAccountId,
      senderId,
      action: "approve",
      approvalKind: params.approvalKind,
    }).authorized;
  if (!isActorAuthorized(accountId)) {
    return null;
  }
  const eligibleAccountIds = plugin.config.listAccountIds(params.cfg).filter(isActorAuthorized);
  if (!eligibleAccountIds.includes(accountId)) {
    return null;
  }
  return {
    resolverId: `${channel}:${accountId}`,
    authorizes: (request, target, resolutionProof) => {
      if (
        !doesApprovalRequestSelectChannelAccount({
          cfg: params.cfg,
          request,
          channel,
          accountId,
          defaultAccountId: plugin.config.defaultAccountId?.(params.cfg) ?? "",
          eligibleAccountIds,
        })
      ) {
        return false;
      }
      if (!capability.authorizeApprovalResolution || target === undefined) {
        return true;
      }
      return capability.authorizeApprovalResolution({
        cfg: params.cfg,
        accountId,
        senderId,
        approvalKind: params.approvalKind,
        target,
        ...(resolutionProof ? { resolutionProof } : {}),
      }).authorized;
    },
  };
}
