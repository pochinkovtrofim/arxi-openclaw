import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tempRootModule from "../../infra/tmp-openclaw-dir.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";

describe("prepareClaudeCliSkillsPlugin", () => {
  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-claude-skills-test-" });
  let base: string;
  let pluginTempRoot: string;
  let skillsSnapshot: SkillSnapshot;

  beforeEach(async () => {
    base = await tempRoot.setup();
    pluginTempRoot = path.join(base, "tmp");
    const skillDir = path.join(base, "source", "demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(pluginTempRoot, { recursive: true });
    await fs.writeFile(skillFile, "# Demo\n", "utf8");
    skillsSnapshot = {
      prompt: "demo",
      skills: [{ name: "demo" }],
      resolvedSkills: [
        {
          name: "demo",
          description: "Demo skill",
          filePath: skillFile,
          baseDir: skillDir,
          source: "openclaw-workspace",
          sourceInfo: {
            path: skillFile,
            source: "openclaw-workspace",
            scope: "project",
            origin: "top-level",
            baseDir: skillDir,
          },
          disableModelInvocation: false,
        },
      ],
    };
    vi.spyOn(tempRootModule, "resolvePreferredOpenClawTmpDir").mockReturnValue(pluginTempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tempRoot.cleanup();
  });

  it("removes the temporary plugin tree when directory creation fails", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(error);

    await expect(
      prepareClaudeCliSkillsPlugin({ backendId: "claude-cli", skillsSnapshot }),
    ).rejects.toBe(error);
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it("removes the temporary plugin tree when the manifest write fails", async () => {
    const error = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(error);

    await expect(
      prepareClaudeCliSkillsPlugin({ backendId: "claude-cli", skillsSnapshot }),
    ).rejects.toBe(error);
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it("gives plugin dirs that link the same skill sources one reload layout", async () => {
    const demo = skillsSnapshot.resolvedSkills?.[0];
    if (!demo) {
      throw new Error("The fixture snapshot has no skill.");
    }
    const otherDir = path.join(base, "source", "other");
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(otherDir, "SKILL.md"), "# Other\n", "utf8");
    const other = {
      ...demo,
      name: "other",
      filePath: path.join(otherDir, "SKILL.md"),
      baseDir: otherDir,
    };
    const prepare = (snapshot: Partial<SkillSnapshot>) =>
      prepareClaudeCliSkillsPlugin({
        backendId: "claude-cli",
        skillsSnapshot: { ...skillsSnapshot, ...snapshot },
      });
    const prepared = [
      await prepare({}),
      await prepare({
        resolvedSkills: [{ ...demo, description: "Edited", contentHash: "edited" }],
      }),
      await prepare({ resolvedSkills: [demo, other] }),
      await prepare({ resolvedSkills: [{ ...demo, name: "renamed" }] }),
      await prepare({ resolvedSkills: [{ ...other, name: "demo" }] }),
      await prepare({ skillFilter: ["demo"] }),
    ];
    try {
      const [original, edited, ...changed] = prepared.map((entry) => entry.reloadLayout);
      expect(original).toEqual(expect.any(String));
      expect(edited).toBe(original);
      expect(new Set([original, ...changed]).size).toBe(changed.length + 1);
    } finally {
      await Promise.all(prepared.map((entry) => entry.cleanup()));
    }
  });

  it("leaves a plugin dir with a copied skill without a reload layout", async () => {
    vi.spyOn(fs, "symlink").mockRejectedValueOnce(
      Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
    );
    const prepared = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot,
    });
    try {
      expect(prepared.args).toEqual(["--plugin-dir", prepared.pluginDir]);
      expect(prepared.reloadLayout).toBeUndefined();
    } finally {
      await prepared.cleanup();
    }
  });
});
