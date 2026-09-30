import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Optional runtime origin tying a proposal back to an agent turn. */
export const SkillProposalOriginSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  messageId: Type.Optional(NonEmptyString),
  sourceWorkspaceKey: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  sourceKeys: Type.Optional(
    Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), { maxItems: 64 }),
  ),
  sourceRefs: Type.Optional(
    Type.Record(
      Type.String({ pattern: "^[a-f0-9]{64}$" }),
      closedObject({
        ownerId: NonEmptyString,
        value: Type.String({ minLength: 1, maxLength: 2048 }),
      }),
    ),
  ),
  sourceDeleted: Type.Optional(Type.Literal(true)),
  sourceDeletedKeys: Type.Optional(
    Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), { maxItems: 64 }),
  ),
});

/** Host-captured source category of an autonomous experience review, never model input. */
export const SkillProposalReviewContextSchema = closedObject({
  agentId: NonEmptyString,
  messageChannel: Type.Optional(NonEmptyString),
  chatType: Type.Optional(NonEmptyString),
  trigger: Type.Optional(NonEmptyString),
  senderIsOwner: Type.Optional(Type.Boolean()),
});

/** Skill file target that a proposal creates or updates. */
export const SkillProposalTargetSchema = closedObject({
  skillName: NonEmptyString,
  skillKey: NonEmptyString,
  skillDir: NonEmptyString,
  skillFile: NonEmptyString,
  source: Type.Optional(NonEmptyString),
  currentContentHash: Type.Optional(NonEmptyString),
});
