import { createHash } from "node:crypto";
import path from "node:path";
import {
  GitAttributeFilesUnverifiedError,
  resolveGitGlobalAndSystemAttributeFiles,
} from "../../infra/git-attribute-files.js";
import { normalizeGitPathForFilesystem, type GitCommandOptions } from "../../infra/git-exec.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { requireGit, worktreePathExists } from "./git.js";
import { setWorktreePreparationTemplate } from "./preparation-timing.js";

// Path-dependent filters and sparse configuration need a fresh checkout.
// Hash effective checkout configuration so policy changes retire the cache.
export async function resolveWorktreeCheckoutKey(
  options: {
    destination: string;
    commonDir: string;
    commit: string;
    git: WorktreeGitPolicy;
    gitOptions: GitCommandOptions;
  },
  scope: "template" | "prompt" = "template",
): Promise<string | undefined> {
  const { git, commit } = options;
  if (
    [
      "GIT_INDEX_FILE",
      "GIT_WORK_TREE",
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_CONFIG",
      "GIT_ATTR_SOURCE",
    ].some((key) => process.env[key])
  ) {
    if (scope === "template") {
      setWorktreePreparationTemplate("unavailable", { reason: "git-environment" });
    }
    return undefined;
  }
  const config = await git.require(
    options.destination,
    ["config", "--null", "--list"],
    options.gitOptions,
  );
  const checkoutConfig: string[] = [];
  for (const field of config.split("\0")) {
    const key = field.split("\n", 1)[0]?.toLowerCase() ?? "";
    // Branch settings govern tracking and merge behavior, not checkout contents.
    // Registration adds remote/merge keys; deleting the branch removes them.
    if (key.startsWith("branch.")) {
      continue;
    }
    // Installed drivers (for example Git LFS) need not apply to prompt files.
    // Their effective attributes are checked against the selected index below.
    if (scope === "prompt" && key.startsWith("filter.")) {
      continue;
    }
    if (
      /^(filter\.|includeif\.|core\.(attributesfile|worktree|sparsecheckout|splitindex)$|index\.sparse$)/u.test(
        key,
      )
    ) {
      if (scope === "template") {
        setWorktreePreparationTemplate("unavailable", { reason: "checkout-configuration" });
      }
      return undefined;
    }
    checkoutConfig.push(field);
  }
  if (git.sourceOnly) {
    // Native worktree config can already have changed the retained index and files.
    const fields = (
      await requireGit(
        options.destination,
        ["config", "--null", "--show-scope", "--list"],
        options.gitOptions,
      )
    ).split("\0");
    checkoutConfig.push(
      ...fields.filter(
        (field, index) =>
          index % 2 === 1 && fields[index - 1] === "worktree" && !field.startsWith("branch."),
      ),
    );
  }
  // Outside-tree attributes can select transforms that depend on the checkout path.
  // Leave those repositories with Git until a backend models that contract.
  if (
    !git.sourceOnly &&
    (await worktreePathExists(path.join(options.commonDir, "info", "attributes")))
  ) {
    if (scope === "template") {
      setWorktreePreparationTemplate("unavailable", { reason: "repository-attributes" });
    }
    return undefined;
  }
  // Probes run one at a time, so no admitted Git process outlives a throw or cancellation.
  let attributeFiles: string[];
  try {
    attributeFiles = await resolveGitGlobalAndSystemAttributeFiles(
      async (argv) => {
        const result = await git.run(options.destination, argv.slice(1), options.gitOptions);
        return {
          code:
            result.termination === "exit" && !result.stdoutTruncatedBytes ? result.code : null,
          stdout: result.stdout,
        };
      },
      // The policy may only add GIT_ATTR_NOSYSTEM; a missed one can only retain native checkout.
      { ...process.env, ...options.gitOptions.env },
    );
  } catch (error) {
    if (!(error instanceof GitAttributeFilesUnverifiedError)) {
      throw error;
    }
    if (scope === "template") {
      setWorktreePreparationTemplate("unavailable", { reason: "attributes-probe-failed" });
    }
    return undefined;
  }
  for (const file of attributeFiles) {
    if (await worktreePathExists(path.resolve(options.destination, normalizeGitPathForFilesystem(file)))) {
      if (scope === "template") {
        setWorktreePreparationTemplate("unavailable", { reason: "external-attributes" });
      }
      return undefined;
    }
  }
  return createHash("sha256")
    .update(`source-v2\n${git.sourceOnly}\n${commit}\n${checkoutConfig.join("\0")}`)
    .digest("hex");
}
