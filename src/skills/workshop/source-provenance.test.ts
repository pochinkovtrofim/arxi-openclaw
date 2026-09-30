import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import {
  createTestAdmittedRunContext,
  withTestRunAdmission,
} from "../../agents/admitted-run-context.test-support.js";
import { awaitAgentEndSideEffects } from "../../agents/harness/agent-end-side-effects.js";
import {
  clearMemoryArtifactSourceScope,
  registerMemoryArtifactSourceResolver,
  registerMemoryArtifactSourceScope,
} from "../../memory/memory-artifact-source-authority.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { buildSkillSnapshot, resolveSkillsPrompt } from "../loading/workspace-skill-prompt.js";
import { forgetPendingSkillExperienceSources } from "./experience-review-default.js";
import {
  createExperienceReviewCandidate,
  createExperienceReviewMessages,
} from "./experience-review.test-support.js";
import {
  applySkillProposal,
  proposeCreateSkill,
  proposeUpdateSkill,
  reviseSkillProposal,
} from "./service.js";
import {
  assertWorkshopSourcesCurrent,
  mergeWorkshopSourceOrigins,
  workshopSourceOrigin,
} from "./source-provenance.js";
import { readStoredProposal } from "./store-sqlite-record.js";
import {
  forgetWorkshopSourceExamples,
  listWorkshopSourceMetadata,
  readSkillProposalBundle,
} from "./store.js";

let state: OpenClawTestState;
let release: (() => void) | undefined;
const ownerId = "fixture:workshop-source";
const refA = { ownerId, value: "opaque-source-A" };
const refB = { ownerId, value: "opaque-source-B" };
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "workshop-source-provenance-",
  });
  release = registerMemoryArtifactSourceResolver(ownerId, async (refs) =>
    refs.map(() => "current"),
  );
});
afterEach(async () => {
  release?.();
  await state.cleanup();
});

function create(name: string, refs = [refA]) {
  return proposeCreateSkill({
    workspaceDir: state.stateDir,
    config: {},
    agentId: "main",
    name,
    description: "Reusable operation",
    content: "# Reusable operation\n\nPrivate example from source A.\n",
    origin: {
      agentId: "main",
      runId: "original-foreground",
      ...workshopSourceOrigin(state.stateDir, refs),
    },
  });
}

describe("Workshop exact native source provenance", () => {
  it("captures the actual native agent-end source before cleanup and tombstones a pending review without a proposal", async () => {
    const runId = "native-pending-source-review";
    const messages = createExperienceReviewMessages("fixture-model").positiveMessages();
    const candidate = await createExperienceReviewCandidate(runId, messages, {
      workspaceDir: state.stateDir,
      modelId: "fixture-model",
    });
    const original = workshopSourceOrigin(state.stateDir, [refA]);
    await withTestRunAdmission(
      { admittedRunContext: createTestAdmittedRunContext(runId), runId },
      async (admitted) => {
        const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
        if (!assertCurrent) {
          throw new Error("Native run admission missing");
        }
        registerMemoryArtifactSourceScope({
          runId,
          workspaceDir: state.stateDir,
          assertCurrent,
          refs: [refA],
          complete: true,
        });
        try {
          // The real harness schedules synchronously before plugin cleanup/terminal closure.
          await awaitAgentEndSideEffects({
            event: { messages, success: true },
            ctx: {
              ...candidate.ctx,
              config: candidate.config,
              sessionKey: candidate.source.sessionKey,
              sessionId: candidate.source.sessionId,
              modelIterations: 10,
              skillWorkshopAvailable: true,
            },
            skillExperienceReviewSource: candidate.source,
          });
          const pending = await listWorkshopSourceMetadata({ workspaceDir: state.stateDir });
          expect(pending).toEqual([
            expect.objectContaining({
              sourceKeys: original.sourceKeys,
              sourceRefs: original.sourceRefs,
            }),
          ]);
          expect(pending[0].proposalId).toBeUndefined();
          expect(
            await forgetWorkshopSourceExamples({
              workspaceDir: state.stateDir,
              sourceKeys: original.sourceKeys!,
            }),
          ).toMatchObject({
            scope: "linked_source_provenance_only",
            pendingSources: [],
            refusals: [],
            scrubbedProposals: 0,
          });
          expect(await listWorkshopSourceMetadata({ workspaceDir: state.stateDir })).toEqual([]);
        } finally {
          forgetPendingSkillExperienceSources(state.stateDir, original.sourceKeys!);
          clearMemoryArtifactSourceScope(runId);
          closeAdmittedRunDelegatedAuthority(admitted);
        }
      },
    );
    closeOpenClawStateDatabaseForTest();
    // Current resolver plus a NEW record cannot override the durable original-key deletion.
    await expect(create("Old pending review after restart", [refA])).rejects.toThrow("deleted");
    await expect(create("Independent new review", [refB])).resolves.toBeDefined();
  });

  it("keeps refs in the owning SQLite record and unions revisions without model-minted identities", async () => {
    const first = await create("Source union");
    const revised = await reviseSkillProposal({
      workspaceDir: state.stateDir,
      config: {},
      agentId: "main",
      proposalId: first.record.id,
      content: "# Operation\nIndependent current source B refinement.\n",
      origin: { runId: "later-run", ...workshopSourceOrigin(state.stateDir, [refB]) },
    });
    expect(revised.record.origin?.sourceKeys).toEqual(
      workshopSourceOrigin(state.stateDir, [refA, refB]).sourceKeys,
    );
    const rows = await listWorkshopSourceMetadata({ workspaceDir: state.stateDir });
    expect(rows[0].sourceRefs).toEqual(
      workshopSourceOrigin(state.stateDir, [refA, refB]).sourceRefs,
    );
    expect(() =>
      mergeWorkshopSourceOrigins(first.record.origin, { sourceKeys: ["f".repeat(64)] }),
    ).toThrow("unavailable");
  });

  it("scrubs exact generated bytes, preserves applied lifecycle and sibling, and blocks old-run NEW proposal after reopen", async () => {
    const dependent = await create("Applied dependent", [refA, refB]);
    const sibling = await create("Independent sibling", [refB]);
    const appliedResult = await applySkillProposal({
      workspaceDir: state.stateDir,
      config: {},
      agentId: "main",
      proposalId: dependent.record.id,
    });
    const applied = appliedResult.record;
    expect(applied.sourceAppliedFiles?.length).toBe(1);
    const cachedSnapshot = await buildSkillSnapshot(state.stateDir, {
      config: {},
      agentId: "main",
    });
    expect(
      cachedSnapshot.skills.some((skill) => skill.skillKey === dependent.record.target.skillKey),
    ).toBe(true);
    const siblingFile = path.join(dependent.record.target.skillDir, "manual-sibling.txt");
    await fs.writeFile(siblingFile, "Independent manually supplied content.\n");
    const keyA = workshopSourceOrigin(state.stateDir, [refA]).sourceKeys!;
    expect(
      await forgetWorkshopSourceExamples({
        workspaceDir: state.stateDir,
        sourceKeys: keyA,
        dryRun: true,
      }),
    ).toMatchObject({ pendingSources: [], scrubbedProposals: 0 });
    expect((await readSkillProposalBundle(applied, {})).content).toContain("Private example");
    expect(
      await forgetWorkshopSourceExamples({ workspaceDir: state.stateDir, sourceKeys: keyA }),
    ).toMatchObject({ pendingSources: [], refusals: [], scrubbedProposals: 1 });
    const scrubbed = readStoredProposal(dependent.record.id)!.record;
    expect(scrubbed).toMatchObject({
      status: "applied",
      appliedAt: applied.appliedAt,
      target: dependent.record.target,
      origin: { sourceDeleted: true, sourceDeletedKeys: keyA },
    });
    expect(JSON.stringify(scrubbed)).not.toContain("Private example");
    await expect(fs.stat(dependent.record.target.skillFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(siblingFile, "utf8")).toBe("Independent manually supplied content.\n");
    expect(
      await resolveSkillsPrompt({
        workspaceDir: state.stateDir,
        agentId: "main",
        config: {},
        skillsSnapshot: cachedSnapshot,
      }),
    ).not.toContain(dependent.record.target.skillKey);
    expect(readStoredProposal(sibling.record.id)!.record).toEqual(sibling.record);
    await expect(readSkillProposalBundle(scrubbed, {})).rejects.toThrow("deleted");
    const bundle = path.join(state.stateDir, "skill-workshop", "proposals", dependent.record.id);
    await expect(fs.stat(bundle)).rejects.toMatchObject({ code: "ENOENT" });
    closeOpenClawStateDatabaseForTest();
    release?.();
    // Resolver remains current deliberately: durable original-key barrier alone must prevent laundering.
    release = registerMemoryArtifactSourceResolver(ownerId, async (refs) =>
      refs.map(() => "current"),
    );
    await expect(create("Delayed old run new proposal", [refA])).rejects.toThrow("deleted");
    await expect(
      proposeCreateSkill({
        workspaceDir: state.stateDir,
        config: {},
        agentId: "other-steward",
        name: "Deleted source other steward",
        description: "Independent runtime identity cannot launder a deleted source",
        content: "# No copied example\n",
        origin: dependent.record.origin,
      }),
    ).rejects.toThrow("deleted");
    await expect(
      assertWorkshopSourcesCurrent(dependent.record.origin, state.stateDir),
    ).rejects.toThrow("deleted");
    await expect(create("Unrelated source B remains eligible", [refB])).resolves.toBeDefined();
    expect(
      await forgetWorkshopSourceExamples({ workspaceDir: state.stateDir, sourceKeys: keyA }),
    ).toMatchObject({ pendingSources: [], refusals: [] });
  });

  it("inherits original A provenance when a NEW B update retains exact current applied A bytes", async () => {
    const original = await create("Inherited applied source", [refA]);
    await applySkillProposal({
      workspaceDir: state.stateDir,
      config: {},
      agentId: "main",
      proposalId: original.record.id,
    });
    const content = await fs.readFile(original.record.target.skillFile, "utf8");
    const next = await proposeUpdateSkill({
      workspaceDir: state.stateDir,
      config: {},
      agentId: "main",
      skillName: original.record.target.skillKey,
      description: "Add a current B refinement",
      content: content + "\nA B refinement.\n",
      origin: workshopSourceOrigin(state.stateDir, [refB]),
    });
    expect(next.record.origin?.sourceKeys).toEqual(
      workshopSourceOrigin(state.stateDir, [refA, refB]).sourceKeys,
    );
    expect(
      await forgetWorkshopSourceExamples({
        workspaceDir: state.stateDir,
        sourceKeys: workshopSourceOrigin(state.stateDir, [refA]).sourceKeys!,
      }),
    ).toMatchObject({ pendingSources: [], refusals: [] });
    await expect(readSkillProposalBundle(next.record, {})).rejects.toThrow("deleted");
  });

  it("retains manually changed applied bytes as pending while holding cached prompt eligibility", async () => {
    const proposal = await create("Manual conflict");
    await applySkillProposal({
      workspaceDir: state.stateDir,
      config: {},
      agentId: "main",
      proposalId: proposal.record.id,
    });
    const cachedSnapshot = await buildSkillSnapshot(state.stateDir, {
      config: {},
      agentId: "main",
    });
    const manual = "# Manual edit\nDo not erase unrelated current bytes.\n";
    await fs.writeFile(proposal.record.target.skillFile, manual);
    const keys = proposal.record.origin!.sourceKeys!;
    const result = await forgetWorkshopSourceExamples({
      workspaceDir: state.stateDir,
      sourceKeys: keys,
    });
    expect(result.pendingSources).toEqual(keys);
    expect(result.refusals.length).toBe(1);
    expect(await fs.readFile(proposal.record.target.skillFile, "utf8")).toBe(manual);
    expect(readStoredProposal(proposal.record.id)!.record).toMatchObject({
      status: "applied",
      origin: { sourceDeleted: true },
    });
    expect(
      await resolveSkillsPrompt({
        workspaceDir: state.stateDir,
        agentId: "main",
        config: {},
        skillsSnapshot: cachedSnapshot,
      }),
    ).not.toContain(proposal.record.target.skillKey);
  });

  it("refuses revoked or unavailable source before proposal registration, without guessing origin", async () => {
    release?.();
    release = registerMemoryArtifactSourceResolver(ownerId, async () => ["revoked"]);
    await expect(create("Revoked source")).rejects.toThrow("currentness");
    expect(await listWorkshopSourceMetadata({ workspaceDir: state.stateDir })).toEqual([]);
    release?.();
    release = undefined;
    await expect(create("Unknown source")).rejects.toThrow("currentness");
    await expect(
      forgetWorkshopSourceExamples({ workspaceDir: state.stateDir, sourceKeys: ["f".repeat(64)] }),
    ).rejects.toThrow("no owning provenance");
  });
});
