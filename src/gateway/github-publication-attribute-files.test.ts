import { describe, expect, it } from "vitest";
import { resolveGitGlobalAndSystemAttributeFiles } from "./github-publication-attribute-files.js";

type Reply = { code: number; stdout?: string };

function gitWith(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const run = async (argv: string[]) => {
    const key = argv.slice(1).join(" ");
    calls.push(key);
    const reply = replies[key];
    if (!reply) {
      throw new Error(`unexpected git ${key}`);
    }
    return { code: reply.code, stdout: Buffer.from(reply.stdout ?? "") };
  };
  return { run, calls };
}

// Git 2.39 (Debian 12) answers both attribute variables with usage().
const legacyVar = {
  "var GIT_ATTR_GLOBAL": { code: 129 },
  "var GIT_ATTR_SYSTEM": { code: 129 },
};

describe("resolveGitGlobalAndSystemAttributeFiles", () => {
  it("takes both paths from git var on current Git", async () => {
    const { run } = gitWith({
      "var GIT_ATTR_GLOBAL": { code: 0, stdout: "/home/owner/.config/git/attributes\n" },
      "var GIT_ATTR_SYSTEM": { code: 0, stdout: "/etc/gitattributes\n" },
    });
    await expect(resolveGitGlobalAndSystemAttributeFiles(run, {})).resolves.toEqual([
      "/home/owner/.config/git/attributes",
      "/etc/gitattributes",
    ]);
  });

  it("skips a source current Git reports as disabled", async () => {
    const { run } = gitWith({
      "var GIT_ATTR_GLOBAL": { code: 1 },
      "var GIT_ATTR_SYSTEM": { code: 1 },
    });
    await expect(resolveGitGlobalAndSystemAttributeFiles(run, {})).resolves.toEqual([]);
  });

  it("follows Git's documented lookup on Git without the attribute variables", async () => {
    const { run } = gitWith({
      ...legacyVar,
      "config --type=path --get core.attributesFile": { code: 1 },
      "--exec-path": { code: 0, stdout: "/usr/lib/git-core\n" },
    });
    await expect(
      resolveGitGlobalAndSystemAttributeFiles(run, { HOME: "/home/owner" }),
    ).resolves.toEqual(["/home/owner/.config/git/attributes", "/etc/gitattributes"]);
    await expect(
      resolveGitGlobalAndSystemAttributeFiles(run, { HOME: "/home/owner", XDG_CONFIG_HOME: "/xdg" }),
    ).resolves.toEqual(["/xdg/git/attributes", "/etc/gitattributes"]);
  });

  it("prefers core.attributesFile and reads both system candidates of a non-/usr prefix", async () => {
    const { run } = gitWith({
      ...legacyVar,
      "config --type=path --get core.attributesFile": { code: 0, stdout: "/owner/attributes\n" },
      "--exec-path": { code: 0, stdout: "/opt/git/libexec/git-core\n" },
    });
    await expect(
      resolveGitGlobalAndSystemAttributeFiles(run, { HOME: "/home/owner" }),
    ).resolves.toEqual(["/owner/attributes", "/etc/gitattributes", "/opt/git/etc/gitattributes"]);
  });

  it("honours GIT_ATTR_NOSYSTEM and a missing home on Git without the attribute variables", async () => {
    const { run, calls } = gitWith({
      ...legacyVar,
      "config --type=path --get core.attributesFile": { code: 1 },
    });
    await expect(
      resolveGitGlobalAndSystemAttributeFiles(run, { GIT_ATTR_NOSYSTEM: "true" }),
    ).resolves.toEqual([]);
    expect(calls).not.toContain("--exec-path");
  });

  it.each([
    ["an unknown install layout", { "--exec-path": { code: 0, stdout: "/opt/git/bin\n" } }],
    ["a failed exec-path probe", { "--exec-path": { code: 128 } }],
  ])("refuses to guess the system file from %s", async (_label, replies) => {
    const { run } = gitWith({
      ...legacyVar,
      "config --type=path --get core.attributesFile": { code: 1 },
      ...replies,
    });
    await expect(resolveGitGlobalAndSystemAttributeFiles(run, { HOME: "/h" })).rejects.toThrow(
      "attributes could not be verified",
    );
  });

  it.each([
    ["git var", { "var GIT_ATTR_GLOBAL": { code: 128 } }],
    [
      "core.attributesFile",
      { ...legacyVar, "config --type=path --get core.attributesFile": { code: 3 } },
    ],
  ])("refuses when %s fails", async (_label, replies) => {
    const { run } = gitWith(replies);
    await expect(resolveGitGlobalAndSystemAttributeFiles(run, { HOME: "/h" })).rejects.toThrow(
      "attributes could not be verified",
    );
  });
});
