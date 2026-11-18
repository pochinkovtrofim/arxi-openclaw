import path from "node:path";

type GitAttributeProbeResult = { code: number | null; stdout: Buffer | string };
type GitAttributeProbe = (argv: string[]) => Promise<GitAttributeProbeResult>;

// Git's usage() exit: `git var` before 2.42 does not know GIT_ATTR_GLOBAL or GIT_ATTR_SYSTEM.
const GIT_USAGE_EXIT_CODE = 129;

/** Git applies attribute files here that this process cannot name. */
export class GitAttributeFilesUnverifiedError extends Error {
  constructor() {
    super("Git attribute files could not be verified.");
  }
}

function probedPath(result: GitAttributeProbeResult): string | undefined {
  const value = result.stdout.toString().trim();
  return value || undefined;
}

// git_env_bool: an unparseable value makes Git itself fail, so it never disables a source here.
function gitEnvironmentFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/^(?:true|yes|on)$/u.test(normalized)) {
    return true;
  }
  return /^-?\d+$/u.test(normalized) && Number(normalized) !== 0;
}

async function legacyGlobalAttributeFiles(
  run: GitAttributeProbe,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const configured = await run(["git", "config", "--type=path", "--get", "core.attributesFile"]);
  if (configured.code === 0) {
    const file = probedPath(configured);
    return file ? [file] : [];
  }
  if (configured.code !== 1) {
    throw new GitAttributeFilesUnverifiedError();
  }
  // gitattributes(5): $XDG_CONFIG_HOME/git/attributes, or $HOME/.config/git/attributes
  // when XDG_CONFIG_HOME is unset or empty.
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) {
    return [path.join(xdg, "git", "attributes")];
  }
  // Git's xdg_config_home() tests only that HOME is set: HOME="" reads /.config/git/attributes.
  return env.HOME !== undefined ? [path.join(env.HOME || "/", ".config", "git", "attributes")] : [];
}

async function legacySystemAttributeFiles(
  run: GitAttributeProbe,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  if (gitEnvironmentFlag(env.GIT_ATTR_NOSYSTEM)) {
    return [];
  }
  // A /usr Git reads $(sysconfdir)/gitattributes = /etc/gitattributes. Other builds may set
  // their own sysconfdir or ETC_GITATTRIBUTES, which old Git cannot report: refuse them.
  const execPath = await run(["git", "--exec-path"]);
  if (
    execPath.code !== 0 ||
    env.GIT_EXEC_PATH !== undefined ||
    !/^\/usr\/(?:libexec|lib)\/git-core\/?$/u.test(probedPath(execPath) ?? "")
  ) {
    throw new GitAttributeFilesUnverifiedError();
  }
  return ["/etc/gitattributes"];
}

/**
 * The system and global attribute files Git applies in this environment. Git 2.42+ names
 * them through `git var`; older Git (Debian 12, the Owner VM base, ships 2.39) gets Git's
 * documented lookup instead. Paths may be relative to the repository, as Git reads them.
 */
export async function resolveGitGlobalAndSystemAttributeFiles(
  run: GitAttributeProbe,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const files: string[] = [];
  for (const [name, legacy] of [
    ["GIT_ATTR_GLOBAL", legacyGlobalAttributeFiles],
    ["GIT_ATTR_SYSTEM", legacySystemAttributeFiles],
  ] as const) {
    const result = await run(["git", "var", name]);
    if (result.code === 0) {
      const file = probedPath(result);
      files.push(...(file ? [file] : []));
    } else if (result.code === 1 && !probedPath(result)) {
      // A known but disabled source, such as GIT_ATTR_NOSYSTEM=1 or no HOME.
      continue;
    } else if (result.code === GIT_USAGE_EXIT_CODE) {
      files.push(...(await legacy(run, env)));
    } else {
      throw new GitAttributeFilesUnverifiedError();
    }
  }
  return files;
}
