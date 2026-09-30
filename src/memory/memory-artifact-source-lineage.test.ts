import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRecentDreamDiaryEntries,
  writeBackfillDiaryEntries,
} from "../../extensions/memory-core/src/dreaming-dreams-file.js";
import { writeDailyDreamingPhaseBlock } from "../../extensions/memory-core/src/dreaming-markdown.js";
import { runDreamNarrative } from "../../extensions/memory-core/src/dreaming-narrative.js";
import { copyDreamingSource } from "../../extensions/memory-core/src/dreaming-source-lineage.js";
import { applyShortTermPromotions } from "../../extensions/memory-core/src/short-term-promotion-apply.js";
import {
  recordShortTermRecalls,
  filterLiveShortTermRecallEntries,
} from "../../extensions/memory-core/src/short-term-promotion-record.js";
import { rehydratePromotionCandidate } from "../../extensions/memory-core/src/short-term-promotion-rehydrate.js";
import { readStore } from "../../extensions/memory-core/src/short-term-promotion-store.js";
import { rankShortTermPromotionCandidates } from "../../extensions/memory-core/src/short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../../extensions/memory-core/src/test-helpers.js";
import {
  closeAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import {
  createTestAdmittedRunContext,
  withTestRunAdmission,
} from "../agents/admitted-run-context.test-support.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "../agents/memory-write-provenance.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import {
  createCorePluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  projectMemoryArtifactSourceContent,
  readMemoryArtifactProvenance,
  type MemoryArtifactProvenance,
} from "./memory-artifact-provenance.js";
import {
  clearInactiveMemoryArtifactSourceScope,
  clearMemoryArtifactSourceScope,
  memoryArtifactSourceKey,
  readMemoryArtifactSourceScope,
  recordMemoryArtifactSourcesFromActiveTool,
  registerMemoryArtifactSourceResolver,
  registerMemoryArtifactSourceScope,
  type MemoryArtifactSourceRef,
  type MemoryArtifactSourceStatus,
} from "./memory-artifact-source-authority.js";
import { memorySourceTextHash } from "./memory-artifact-source-regions.js";

afterEach(() => {
  resetMemoryCoreDreamingStateForTests();
  resetPluginStateStoreForTests();
});

// Only the host source reader is synthetic. Admission, native writer, physical
// files, source projection and the core SQLite store use their real owners.
async function withSourceWorkspace(
  run: (fixture: Awaited<ReturnType<typeof sourceFixture>>) => Promise<void>,
) {
  await withStateDirEnv("openclaw-memory-lineage-", async ({ tempRoot }) => {
    const fixture = await sourceFixture(tempRoot);
    try {
      await run(fixture);
    } finally {
      fixture.dispose();
      resetPluginStateStoreForTests();
    }
  });
}

async function sourceFixture(tempRoot: string) {
  const workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  const ownerId = `fixture:${randomUUID()}`;
  const statuses = new Map<string, MemoryArtifactSourceStatus>();
  let beforeResolve: (() => void) | undefined;
  const unregister = registerMemoryArtifactSourceResolver(ownerId, async (refs) => {
    beforeResolve?.();
    return refs.map((value) => statuses.get(value) ?? "unavailable");
  });
  const ref = (value: string): MemoryArtifactSourceRef => {
    statuses.set(value, "current");
    return { ownerId, value };
  };
  const address = (relativePath = "MEMORY.md") => ({ workspaceDir, relativePath });
  const observer = createMemoryWriteProvenanceObserver({
    mutationRoot: workspaceDir,
    workspaceDir,
    resolveOriginClass: () => "agent",
  });
  const project = async (relativePath = "MEMORY.md") => {
    const result = await projectMemoryArtifactSourceContent({
      ...address(relativePath),
      content: await fs.readFile(path.join(workspaceDir, relativePath), "utf8"),
    });
    expect(result.tombstonedRegions).toEqual(
      result.status === "tombstoned" ? result.blockedRegions : [],
    );
    return {
      content: result.content,
      status: result.status,
      blockedRegions: result.blockedRegions,
    };
  };
  const storedRows = () =>
    createCorePluginStateKeyedStore<
      MemoryArtifactProvenance & { version: number; relativePath: string }
    >({
      ownerId: "core:memory-artifact-provenance",
      namespace: "workspace-files",
      maxEntries: 50_000,
      overflowPolicy: "reject-new",
    }).entries();
  const write = async (
    content: string,
    refs: readonly MemoryArtifactSourceRef[],
    options: {
      relativePath?: string;
      complete?: boolean;
      closeDuringSourceCheck?: boolean;
      appendToolRefs?: readonly MemoryArtifactSourceRef[];
    } = {},
  ) => {
    const runId = randomUUID();
    return withTestRunAdmission(
      { admittedRunContext: createTestAdmittedRunContext(runId), runId },
      async (admitted) => {
        const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
        if (!assertCurrent) {
          throw new Error("Real run admission did not provide source authority");
        }
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: `agent:main:${runId}`,
        });
        if (!caller) {
          throw new Error("Real admitted Gateway caller was not created");
        }
        registerMemoryArtifactSourceScope({
          runId,
          workspaceDir,
          assertCurrent,
          refs,
          complete: options.complete ?? true,
        });
        if (options.closeDuringSourceCheck) {
          beforeResolve = () => closeAdmittedRunDelegatedAuthority(admitted);
        }
        const writer = withMemoryWriteProvenance(
          {
            readFile: (file: string) => fs.readFile(file),
            writeFile: (file: string, value: string) => fs.writeFile(file, value),
          },
          createMemoryWriteProvenanceObserver({
            mutationRoot: workspaceDir,
            workspaceDir,
            runId,
            resolveOriginClass: () => "agent",
          }),
        );
        try {
          return await withGatewayToolCallerIdentity(caller, async () => {
            if (options.appendToolRefs) {
              recordMemoryArtifactSourcesFromActiveTool(options.appendToolRefs);
            }
            await writer.writeFile(
              path.join(workspaceDir, options.relativePath ?? "MEMORY.md"),
              content,
            );
          });
        } finally {
          beforeResolve = undefined;
          clearMemoryArtifactSourceScope(runId);
        }
      },
    );
  };
  return {
    workspaceDir,
    address,
    ref,
    statuses,
    write,
    project,
    storedRows,
    observer,
    dispose: unregister,
  };
}

describe("native memory artifact source lineage", () => {
  it("persists only changed regions from admitted prompt and later authorized source tools", async () => {
    await withSourceWorkspace(async (f) => {
      const promptSource = f.ref("prompt:revision:1");
      const toolSource = f.ref("read:revision:2");
      await f.write("Independent preference.\n", []);
      await f.write("Independent preference.\nDerived appointment.\n", [promptSource], {
        appendToolRefs: [toolSource],
      });
      const rows = await f.storedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toMatchObject({
        version: 1,
        relativePath: "MEMORY.md",
        fileHash: memorySourceTextHash("Independent preference.\nDerived appointment.\n"),
        sourceLineage: {
          sources: {
            [memoryArtifactSourceKey(promptSource)]: promptSource,
            [memoryArtifactSourceKey(toolSource)]: toolSource,
          },
          regions: [
            {
              from: 2,
              to: 2,
              sha256: memorySourceTextHash("Derived appointment.\n"),
              sources: [memoryArtifactSourceKey(promptSource), memoryArtifactSourceKey(toolSource)],
            },
          ],
        },
      });
      expect(await f.project()).toMatchObject({ status: "current", blockedRegions: [] });
    });
  });

  it("tombstones a revoked derived region across SQLite reopen without deleting mixed or sibling history", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:revision:1");
      const sibling = "memory/unrelated.md";
      await f.write("Sibling fact.\n", [], { relativePath: sibling });
      await f.write("Independent preference.\n", []);
      await f.write("Independent preference.\nDerived appointment.\n", [source]);
      await f.write("Independent preference.\nDerived appointment.\nIndependent note.\n", []);
      const siblingRow = await readMemoryArtifactProvenance(f.address(sibling));
      const original = await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8");
      f.statuses.set(source.value, "revoked");
      expect(await f.project()).toEqual({
        content: "Independent preference.\n\nIndependent note.\n",
        status: "tombstoned",
        blockedRegions: [{ from: 2, to: 2 }],
      });
      expect(await f.observer.read!(path.join(f.workspaceDir, "MEMORY.md"), original)).toBe(
        "Independent preference.\n\nIndependent note.\n",
      );
      resetPluginStateStoreForTests();
      f.statuses.set(source.value, "current");
      expect(await f.project()).toMatchObject({
        status: "tombstoned",
        content: "Independent preference.\n\nIndependent note.\n",
      });
      expect(
        (await readMemoryArtifactProvenance(f.address()))?.sourceLineage?.regions[0].tombstoned,
      ).toBe(true);
      expect(await f.project(sibling)).toEqual({
        content: "Sibling fact.\n",
        status: "current",
        blockedRegions: [],
      });
      expect(await readMemoryArtifactProvenance(f.address(sibling))).toEqual(siblingRow);
      expect(await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8")).toBe(original);
    });
  });

  it("keeps independently sourced current regions when another source is revoked", async () => {
    await withSourceWorkspace(async (f) => {
      const first = f.ref("message:first");
      const second = f.ref("message:second");
      await f.write("First derived fact.\n", [first]);
      await f.write("First derived fact.\nSecond derived fact.\n", [second]);
      f.statuses.set(first.value, "revoked");
      expect(await f.project()).toEqual({
        content: "\nSecond derived fact.\n",
        status: "tombstoned",
        blockedRegions: [{ from: 1, to: 1 }],
      });
      expect(
        (await readMemoryArtifactProvenance(f.address()))?.sourceLineage?.regions[1],
      ).toMatchObject({ from: 2, to: 2, sources: [memoryArtifactSourceKey(second)] });
    });
  });

  it("holds unavailable evidence reversibly without persisting a false revocation", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:temporarily-unavailable");
      await f.write("Derived fact.\n", [source]);
      const before = await f.storedRows();
      f.statuses.set(source.value, "unavailable");
      expect(await f.project()).toEqual({
        content: "\n",
        status: "held",
        blockedRegions: [{ from: 1, to: 1 }],
      });
      resetPluginStateStoreForTests();
      expect(await f.storedRows()).toEqual(before);
      f.statuses.set(source.value, "current");
      expect(await f.project()).toEqual({
        content: "Derived fact.\n",
        status: "current",
        blockedRegions: [],
      });
    });
  });

  it("holds within the caller deadline when the registered source reader is delayed", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:delayed");
      await f.write("Derived fact.\n", [source]);
      const before = await f.storedRows();
      f.dispose();
      const unregister = registerMemoryArtifactSourceResolver(
        source.ownerId,
        async (_refs, { signal }) => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          // A late reply cannot make an aborted lookup authoritative.
          return ["revoked"];
        },
      );
      try {
        const started = Date.now();
        const result = await projectMemoryArtifactSourceContent({
          ...f.address(),
          content: "Derived fact.\n",
          signal: AbortSignal.timeout(30),
        });
        expect(Date.now() - started).toBeLessThan(900);
        expect(result).toMatchObject({ status: "held", content: "\n", tombstonedRegions: [] });
        expect(await f.storedRows()).toEqual(before);
      } finally {
        unregister();
      }
    });
  });

  it("holds a source reply whose owning resolver stopped before returning", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:resolver-stopped");
      await f.write("Derived fact.\n", [source]);
      const before = await f.storedRows();
      f.dispose();
      const unregister = registerMemoryArtifactSourceResolver(source.ownerId, async () => {
        unregister();
        return ["current"];
      });
      try {
        expect(await f.project()).toEqual({
          content: "\n",
          status: "held",
          blockedRegions: [{ from: 1, to: 1 }],
        });
        expect(await f.storedRows()).toEqual(before);
      } finally {
        unregister();
      }
    });
  });

  it("holds a missing owning reader across reopen until that owner is genuinely registered again", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:reader-reloaded");
      await f.write("Derived fact.\n", [source]);
      const before = await f.storedRows();
      f.dispose();
      resetPluginStateStoreForTests();
      expect(await f.project()).toMatchObject({ status: "held", content: "\n" });
      expect(await f.storedRows()).toEqual(before);
      const unregister = registerMemoryArtifactSourceResolver(source.ownerId, async (refs) =>
        refs.map((value) => f.statuses.get(value) ?? "unavailable"),
      );
      try {
        expect(await f.project()).toEqual({
          content: "Derived fact.\n",
          status: "current",
          blockedRegions: [],
        });
      } finally {
        unregister();
      }
    });
  });

  it("holds a manually changed file and refuses to overwrite its unknown preimage", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:original");
      await f.write("Derived fact.\n", [source]);
      const before = await f.storedRows();
      const file = path.join(f.workspaceDir, "MEMORY.md");
      await fs.writeFile(file, "Manually revised history.\n");
      expect(await f.project()).toEqual({
        content: "",
        status: "held",
        blockedRegions: [{ from: 1, to: 1 }],
      });
      await expect(f.write("Replacement.\n", [source])).rejects.toThrow(
        "changed outside the owning writer",
      );
      expect(await fs.readFile(file, "utf8")).toBe("Manually revised history.\n");
      expect(await f.storedRows()).toEqual(before);
    });
  });

  it("does not resurrect a tombstone through an unchanged native rewrite under a new current source", async () => {
    await withSourceWorkspace(async (f) => {
      const originalSource = f.ref("message:old");
      await f.write("Derived fact.\n", [originalSource]);
      f.statuses.set(originalSource.value, "revoked");
      await f.project();
      const newSource = f.ref("message:new");
      await f.write("Derived fact.\n", [newSource]);
      expect(await f.project()).toEqual({
        content: "\n",
        status: "tombstoned",
        blockedRegions: [{ from: 1, to: 1 }],
      });
      expect((await readMemoryArtifactProvenance(f.address()))?.sourceLineage?.sources).toEqual({
        [memoryArtifactSourceKey(originalSource)]: originalSource,
      });
      expect(await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8")).toBe(
        "Derived fact.\n",
      );
    });
  });

  it.each([false, true])(
    "retains a rewritten region's original dependency without new source evidence (already tombstoned=%s)",
    async (tombstoned) => {
      await withSourceWorkspace(async (f) => {
        const source = f.ref("message:rephrased-original");
        await f.write("Independent preference.\n", []);
        await f.write("Independent preference.\nOriginal derived appointment.\n", [source]);
        if (tombstoned) {
          f.statuses.set(source.value, "revoked");
          await f.project();
        }
        await f.write("Independent preference.\nRephrased derived appointment.\n", []);
        expect((await readMemoryArtifactProvenance(f.address()))?.sourceLineage?.regions).toEqual([
          {
            from: 2,
            to: 2,
            sha256: memorySourceTextHash("Rephrased derived appointment.\n"),
            sources: [memoryArtifactSourceKey(source)],
            ...(tombstoned ? { tombstoned: true } : {}),
          },
        ]);
        f.statuses.set(source.value, "revoked");
        expect(await f.project()).toEqual({
          content: "Independent preference.\n\n",
          status: "tombstoned",
          blockedRegions: [{ from: 2, to: 2 }],
        });
      });
    },
  );

  it("preserves old dependencies and tombstone when rewriting after an unrelated current source read", async () => {
    await withSourceWorkspace(async (f) => {
      const old = f.ref("source:old");
      await f.write("Derived original fact.\n", [old]);
      f.statuses.set(old.value, "revoked");
      await f.project();
      const unrelated = f.ref("source:unrelated");
      await f.write("Rephrased original fact.\n", [unrelated]);
      expect(await f.project()).toEqual({
        content: "\n",
        status: "tombstoned",
        blockedRegions: [{ from: 1, to: 1 }],
      });
      expect(
        (await readMemoryArtifactProvenance(f.address()))?.sourceLineage?.regions[0].sources,
      ).toEqual([memoryArtifactSourceKey(unrelated), memoryArtifactSourceKey(old)]);
    });
  });

  it("keeps an active native scope during a late terminal callback and retires it after actual closure", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:terminal-native-instance");
      const runId = randomUUID();
      await withTestRunAdmission(
        { admittedRunContext: createTestAdmittedRunContext(runId), runId },
        async (admitted) => {
          const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey: `agent:main:${runId}`,
          });
          if (!assertCurrent || !caller) {
            throw new Error("Real native admission unavailable");
          }
          registerMemoryArtifactSourceScope({
            runId,
            workspaceDir: f.workspaceDir,
            assertCurrent,
            refs: [source],
            complete: true,
          });
          try {
            clearInactiveMemoryArtifactSourceScope(runId);
            await withGatewayToolCallerIdentity(caller, () =>
              expect(readMemoryArtifactSourceScope(runId, f.workspaceDir)).toEqual([source]),
            );
            closeAdmittedRunDelegatedAuthority(admitted);
            clearInactiveMemoryArtifactSourceScope(runId);
            expect(readMemoryArtifactSourceScope(runId, f.workspaceDir)).toBeUndefined();
          } finally {
            clearMemoryArtifactSourceScope(runId);
          }
        },
      );
    });
  });

  it("rejects copied run-id metadata from another real admitted instance", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:exact-native-instance");
      const runId = randomUUID();
      const otherRunId = randomUUID();
      await withTestRunAdmission(
        { admittedRunContext: createTestAdmittedRunContext(runId), runId },
        async (admitted) => {
          const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey: `agent:main:${runId}`,
          });
          if (!assertCurrent || !caller) {
            throw new Error("Real native admission unavailable");
          }
          registerMemoryArtifactSourceScope({
            runId,
            workspaceDir: f.workspaceDir,
            assertCurrent,
            refs: [source],
            complete: true,
          });
          try {
            await withGatewayToolCallerIdentity(caller, () => {
              expect(readMemoryArtifactSourceScope(runId, f.workspaceDir)).toEqual([source]);
            });
            await withTestRunAdmission(
              { admittedRunContext: createTestAdmittedRunContext(otherRunId), runId: otherRunId },
              async (other) => {
                const otherCaller = createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext: other,
                  agentId: "main",
                  sessionKey: `agent:main:${otherRunId}`,
                });
                if (!otherCaller) {
                  throw new Error("Second real native admission unavailable");
                }
                expect(other.operationalRunInstance.instanceId).not.toBe(
                  admitted.operationalRunInstance.instanceId,
                );
                // Deliberately tamper only the copied metadata. The second caller's
                // real live receipt and native instance must not grant the first scope.
                await withGatewayToolCallerIdentity(
                  {
                    ...otherCaller,
                    operationalRunInstance: { ...other.operationalRunInstance, runId },
                  },
                  () => {
                    expect(() => readMemoryArtifactSourceScope(runId, f.workspaceDir)).toThrow(
                      "scope unavailable",
                    );
                    expect(() => recordMemoryArtifactSourcesFromActiveTool([source])).toThrow(
                      "run authority unavailable",
                    );
                  },
                );
              },
            );
            await withGatewayToolCallerIdentity(caller, () => {
              expect(readMemoryArtifactSourceScope(runId, f.workspaceDir)).toEqual([source]);
            });
          } finally {
            clearMemoryArtifactSourceScope(runId);
          }
        },
      );
    });
  });

  it.each(["revoked", "unavailable"] as const)(
    "refuses a native write when the admitted source becomes %s",
    async (status) => {
      await withSourceWorkspace(async (f) => {
        const source = f.ref("message:changed-before-write");
        await f.write("Independent preference.\n", []);
        const before = await f.storedRows();
        f.statuses.set(source.value, status);
        await expect(f.write("Derived replacement.\n", [source])).rejects.toThrow(
          "source changed or unavailable",
        );
        expect(await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8")).toBe(
          "Independent preference.\n",
        );
        expect(await f.storedRows()).toEqual(before);
      });
    },
  );

  it("refuses an incomplete source packet and a run closed during asynchronous source checking", async () => {
    await withSourceWorkspace(async (f) => {
      const source = f.ref("message:closed-authority");
      await f.write("Independent preference.\n", []);
      const before = (await f.storedRows()).map(({ key, value }) => ({ key, value }));
      await expect(
        f.write("Derived replacement.\n", [source], { complete: false }),
      ).rejects.toThrow("scope unavailable");
      await expect(
        f.write("Derived replacement.\n", [source], { closeDuringSourceCheck: true }),
      ).rejects.toThrow("authority is no longer active");
      expect(await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8")).toBe(
        "Independent preference.\n",
      );
      // Rollback restores the complete record. The store's bookkeeping write
      // timestamp changes on a real update even when that record is restored.
      expect((await f.storedRows()).map(({ key, value }) => ({ key, value }))).toEqual(before);
    });
  });
});

// Only the registered host source resolver and model completion are synthetic.
// Actual admitted native writer, SQLite store, promotion, managed artifact
// writers and later current-source reads compose across this boundary.
describe("dreaming preserves native source lineage", () => {
  const daily = "memory/2026-09-30.md";
  const snippet = "The appointment is on Friday.";
  const logger = { info() {}, warn() {}, error() {} };
  async function recordCandidate(f: Awaited<ReturnType<typeof sourceFixture>>) {
    await configureMemoryCoreDreamingStateForTests();
    const nowMs = Date.now();
    await recordShortTermRecalls({
      workspaceDir: f.workspaceDir,
      query: "appointment",
      nowMs,
      results: [{ path: daily, startLine: 1, endLine: 1, snippet, source: "memory", score: 1 }],
    });
    return rankShortTermPromotionCandidates({
      workspaceDir: f.workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs,
    });
  }
  const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };

  it("holds cached unknown source quotes without purging recalls or promoting physical history", async () => {
    await withSourceWorkspace(async (f) => {
      const ref = f.ref("appointment:unknown");
      await f.write(`${snippet}\n`, [ref], { relativePath: daily });
      const candidates = await recordCandidate(f);
      expect(candidates).toHaveLength(1);
      const entries = Object.values(
        (await readStore(f.workspaceDir, new Date().toISOString())).entries,
      );
      f.statuses.set(ref.value, "unavailable");
      expect(
        await filterLiveShortTermRecallEntries({
          workspaceDir: f.workspaceDir,
          entries,
          requireCurrentSource: true,
        }),
      ).toEqual([]);
      expect(
        await filterLiveShortTermRecallEntries({ workspaceDir: f.workspaceDir, entries }),
      ).toEqual(entries);
      expect(
        (
          await applyShortTermPromotions({
            workspaceDir: f.workspaceDir,
            candidates,
            ...thresholds,
          })
        ).applied,
      ).toBe(0);
      expect(await fs.readFile(path.join(f.workspaceDir, daily), "utf8")).toBe(`${snippet}\n`);
      expect(
        await fs.stat(path.join(f.workspaceDir, "MEMORY.md")).catch(() => undefined),
      ).toBeUndefined();
      expect(
        Object.keys((await readStore(f.workspaceDir, new Date().toISOString())).entries),
      ).toEqual(entries.map((e) => e.key));
    });
  });

  it("carries actual daily writer refs into promotion and separate reports, preserving manual siblings", async () => {
    await withSourceWorkspace(async (f) => {
      const ref = f.ref("appointment:current");
      await f.write("Independent manual preference.\n", []);
      await f.write("Unrelated Group note.\n", [], { relativePath: "memory/unrelated.md" });
      await f.write(`${snippet}\n`, [ref], { relativePath: daily });
      const candidates = await recordCandidate(f);
      const current = await rehydratePromotionCandidate(f.workspaceDir, candidates[0]!);
      expect(current?.sourceRefs).toEqual([ref]);
      const applied = await applyShortTermPromotions({
        workspaceDir: f.workspaceDir,
        candidates,
        ...thresholds,
      });
      expect(applied.applied).toBe(1);
      expect((await f.project()).content).toContain(snippet);
      const report = await writeDailyDreamingPhaseBlock({
        workspaceDir: f.workspaceDir,
        phase: "light",
        bodyLines: [snippet],
        sourceRefs: current!.sourceRefs,
        hasContent: true,
        nowMs: Date.parse("2026-09-30T12:00:00Z"),
        timezone: "UTC",
        storage: { mode: "separate", separateReports: true },
      });
      const reportRelative = path.relative(f.workspaceDir, report.reportPath!);
      expect((await f.project(reportRelative)).content).toContain(snippet);
      const memoryBytes = await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8");
      f.statuses.set(ref.value, "revoked");
      const currentMemory = await f.project();
      expect(currentMemory.content).not.toContain(snippet);
      expect(currentMemory.content).toContain("Independent manual preference.");
      expect((await f.project(reportRelative)).content).not.toContain(snippet);
      expect((await f.project("memory/unrelated.md")).content).toBe("Unrelated Group note.\n");
      expect(await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryBytes);
      expect(await fs.readFile(report.reportPath!, "utf8")).toContain(snippet);
    });
  });

  it("does not feed held MEMORY regions to consolidation, while preserving exact raw CAS and appending an independent current candidate", async () => {
    await withSourceWorkspace(async (f) => {
      const ref = f.ref("appointment:consolidation");
      await f.write("Independent preference.\n", []);
      await f.write(`Independent preference.\n${snippet}\n`, [ref]);
      const rawBefore = await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8");
      const independent = "Always keep router backups encrypted.";
      await f.write(`${independent}\n`, [], { relativePath: daily });
      await configureMemoryCoreDreamingStateForTests();
      const nowMs = Date.now();
      await recordShortTermRecalls({
        workspaceDir: f.workspaceDir,
        query: "router",
        nowMs,
        results: [
          {
            path: daily,
            startLine: 1,
            endLine: 1,
            snippet: independent,
            source: "memory",
            score: 1,
            provenance: { originClass: "agent", sessionKind: "interactive", observedAt: nowMs },
          },
        ],
      });
      const candidates = await rankShortTermPromotionCandidates({
        workspaceDir: f.workspaceDir,
        ...thresholds,
        nowMs,
      });
      expect(candidates).toHaveLength(1);
      let modelCalls = 0;
      f.statuses.set(ref.value, "unavailable");
      const applied = await applyShortTermPromotions({
        workspaceDir: f.workspaceDir,
        agentId: "main",
        candidates,
        ...thresholds,
        consolidation: {
          logger,
          subagent: {
            complete: async () => {
              modelCalls++;
              return { text: "unused" };
            },
          },
        },
      });
      expect(modelCalls).toBe(0);
      expect(applied.applied).toBe(1);
      const rawAfter = await fs.readFile(path.join(f.workspaceDir, "MEMORY.md"), "utf8");
      expect(rawAfter.startsWith(rawBefore)).toBe(true);
      const current = await f.project();
      expect(current.content).not.toContain(snippet);
      expect(current.content).toContain(independent);
      expect(current.content).toContain("Independent preference.");
      expect(current.status).toBe("held");
    });
  });

  it("rejects late narrative publication after native evidence becomes unavailable and guards a later current diary", async () => {
    await withSourceWorkspace(async (f) => {
      const ref = f.ref("appointment:narrative");
      await f.write(`${snippet}\n`, [ref], { relativePath: daily });
      const candidates = await recordCandidate(f);
      await f.write("Independent diary note.\n", [], { relativePath: "DREAMS.md" });
      const before = await fs.readFile(path.join(f.workspaceDir, "DREAMS.md"), "utf8");
      let calls = 0;
      const data = {
        phase: "light" as const,
        snippets: [snippet],
        sourceEntryKeys: candidates.map((c) => c.key),
      };
      const held = await runDreamNarrative({
        workspaceDir: f.workspaceDir,
        agentId: "main",
        data,
        logger,
        subagent: {
          complete: async () => {
            calls++;
            f.statuses.set(ref.value, "unavailable");
            return { text: snippet };
          },
        },
      });
      expect(calls).toBe(1);
      expect(held.status).toBe("skipped");
      expect(await fs.readFile(path.join(f.workspaceDir, "DREAMS.md"), "utf8")).toBe(before);
      f.statuses.set(ref.value, "current");
      const completed = await runDreamNarrative({
        workspaceDir: f.workspaceDir,
        agentId: "main",
        data,
        logger,
        subagent: { complete: async () => ({ text: snippet }) },
      });
      expect(completed.status).toBe("completed");
      expect(await readRecentDreamDiaryEntries({ workspaceDir: f.workspaceDir })).toEqual([
        snippet,
      ]);
      const rawDiary = await fs.readFile(path.join(f.workspaceDir, "DREAMS.md"), "utf8");
      f.statuses.set(ref.value, "revoked");
      expect(await readRecentDreamDiaryEntries({ workspaceDir: f.workspaceDir })).toEqual([]);
      expect((await f.project("DREAMS.md")).content).toContain("Independent diary note.");
      expect(await fs.readFile(path.join(f.workspaceDir, "DREAMS.md"), "utf8")).toBe(rawDiary);
    });
  });

  it("retains exact original workspace refs through historical scratch copy and refuses stale backfill publication", async () => {
    await withSourceWorkspace(async (f) => {
      await configureMemoryCoreDreamingStateForTests();
      const ref = f.ref("appointment:historical");
      await f.write(`${snippet}\n`, [ref], { relativePath: daily });
      const scratch = path.join(path.dirname(f.workspaceDir), "scratch");
      await fs.mkdir(path.join(scratch, "memory"), { recursive: true });
      const destination = path.join(scratch, daily);
      const copied = await copyDreamingSource({
        sourceWorkspaceDir: f.workspaceDir,
        sourcePath: path.join(f.workspaceDir, daily),
        workspaceDir: scratch,
        destination,
      });
      expect(copied.refs).toEqual([ref]);
      expect(
        (await readMemoryArtifactProvenance({ workspaceDir: scratch, relativePath: daily }))
          ?.sourceLineage,
      ).toBeDefined();
      await copied.assertCurrent();
      await writeBackfillDiaryEntries({
        workspaceDir: f.workspaceDir,
        sourceRefs: copied.refs,
        entries: [{ isoDay: "2026-09-30", bodyLines: [snippet], sourcePath: daily }],
      });
      expect((await f.project("DREAMS.md")).content).toContain(snippet);
      const original = await fs.readFile(path.join(f.workspaceDir, daily), "utf8");
      f.statuses.set(ref.value, "unavailable");
      await expect(copied.assertCurrent()).rejects.toThrow("import held");
      await expect(
        copyDreamingSource({
          sourceWorkspaceDir: f.workspaceDir,
          sourcePath: path.join(f.workspaceDir, daily),
          workspaceDir: scratch,
          destination: path.join(scratch, "memory/2026-09-29.md"),
        }),
      ).rejects.toThrow("import held");
      await expect(
        writeBackfillDiaryEntries({
          workspaceDir: f.workspaceDir,
          sourceRefs: copied.refs,
          entries: [{ isoDay: "2026-09-29", bodyLines: [snippet] }],
        }),
      ).rejects.toThrow("source changed or unavailable");
      expect((await f.project("DREAMS.md")).content).not.toContain(snippet);
      expect(await fs.readFile(path.join(f.workspaceDir, daily), "utf8")).toBe(original);
    });
  });
});
