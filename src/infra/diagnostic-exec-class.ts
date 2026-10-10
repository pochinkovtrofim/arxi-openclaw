/**
 * Content-free class of an `exec` tool command, for diagnostics and analytics.
 *
 * Privacy contract: the class is either one name from EXEC_COMMAND_CLASSES, a
 * fixed list of well-known public binaries and shell builtins, or "other". It
 * never carries arguments, paths, environment values, output or any other text
 * taken from the command: an unlisted first word becomes "other", never itself.
 *
 * Only the first word is read, after leading `NAME=value` assignments, quote
 * removal and any directory prefix (`/usr/bin/python3` -> `python3`). A
 * `sh|bash|zsh|dash -c '<script>'` wrapper classifies the first word of its
 * script, one level deep. Expansions, escapes and other syntax that would need
 * a real shell to resolve the word classify as "other".
 *
 * Arxi's guest diagnostics receiver (arxi-platform
 * internal/guestdiagnostics/exec_class.go) accepts exactly this set and maps
 * anything else to "other"; extend both lists together.
 */
export const EXEC_COMMAND_CLASSES = [
  "awk",
  "base64",
  "bash",
  "bc",
  "bun",
  "cat",
  "cd",
  "chmod",
  "cmp",
  "column",
  "convert",
  "cp",
  "curl",
  "cut",
  "dash",
  "date",
  "deno",
  "df",
  "diff",
  "dig",
  "du",
  "echo",
  "env",
  "exiftool",
  "export",
  "ffmpeg",
  "ffprobe",
  "file",
  "find",
  "free",
  "gh",
  "git",
  "go",
  "grep",
  "gunzip",
  "gzip",
  "head",
  "id",
  "identify",
  "jq",
  "kill",
  "ln",
  "ls",
  "lsof",
  "magick",
  "make",
  "md5sum",
  "mkdir",
  "mktemp",
  "mv",
  "node",
  "npm",
  "npx",
  "openclaw",
  "openssl",
  "pdfinfo",
  "pdftoppm",
  "pdftotext",
  "pgrep",
  "ping",
  "pip",
  "pip3",
  "pkill",
  "pnpm",
  "printf",
  "ps",
  "psql",
  "pwd",
  "python",
  "python3",
  "readlink",
  "realpath",
  "rg",
  "rm",
  "rmdir",
  "rsync",
  "sed",
  "seq",
  "sh",
  "sha256sum",
  "sleep",
  "sort",
  "sqlite3",
  "ssh",
  "stat",
  "sudo",
  "tail",
  "tar",
  "tee",
  "tesseract",
  "test",
  "timeout",
  "touch",
  "tr",
  "tree",
  "uname",
  "uniq",
  "unzip",
  "uptime",
  "uv",
  "wc",
  "wget",
  "which",
  "whoami",
  "xargs",
  "xxd",
  "yq",
  "yt-dlp",
  "zip",
  "zsh",
] as const;

export type DiagnosticExecCommandClass = (typeof EXEC_COMMAND_CLASSES)[number] | "other";

const EXEC_COMMAND_CLASS_SET: ReadonlySet<string> = new Set(EXEC_COMMAND_CLASSES);
const SHELL_WRAPPERS: ReadonlySet<string> = new Set(["bash", "dash", "sh", "zsh"]);
const SHELL_COMMAND_FLAG = /^-[a-z]*c$/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const MAX_LEADING_ASSIGNMENTS = 8;
const WORD_BREAK = /[\s;&|<>()]/u;
const UNSAFE_UNQUOTED = /[$`\\*?[\]{}~#!]/u;

type Word = { text: string; end: number };

/**
 * Reads one shell word starting at `start`. Returns undefined when the word
 * needs expansion or escape handling to resolve, or when there is no word.
 */
function readWord(command: string, start: number): Word | undefined {
  let index = start;
  while (index < command.length && /\s/u.test(command[index]!)) {
    index++;
  }
  let text = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && (char === "$" || char === "`" || char === "\\")) {
        return undefined;
      } else {
        text += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (WORD_BREAK.test(char)) {
      break;
    }
    if (UNSAFE_UNQUOTED.test(char)) {
      return undefined;
    }
    text += char;
    started = true;
  }
  if (quote || !started) {
    return undefined;
  }
  return { text, end: index };
}

function classifyCommand(command: string, allowWrapper: boolean): DiagnosticExecCommandClass {
  let word = readWord(command, 0);
  for (let skipped = 0; word && ASSIGNMENT.test(word.text); skipped++) {
    if (skipped >= MAX_LEADING_ASSIGNMENTS) {
      return "other";
    }
    word = readWord(command, word.end);
  }
  if (!word) {
    return "other";
  }
  const name = word.text.slice(word.text.lastIndexOf("/") + 1);
  if (!EXEC_COMMAND_CLASS_SET.has(name)) {
    return "other";
  }
  if (SHELL_WRAPPERS.has(name)) {
    const flag = readWord(command, word.end);
    if (flag && SHELL_COMMAND_FLAG.test(flag.text)) {
      if (!allowWrapper) {
        return "other";
      }
      const script = readWord(command, flag.end);
      return script ? classifyCommand(script.text, false) : "other";
    }
    // Other option shapes (`bash -o pipefail -c ...`) are not trivially parseable.
    if (flag?.text.startsWith("-")) {
      return "other";
    }
  }
  return name as DiagnosticExecCommandClass;
}

/** Classifies a shell command string; anything that is not a non-empty string is "other". */
export function classifyExecCommand(command: unknown): DiagnosticExecCommandClass {
  return typeof command === "string" ? classifyCommand(command, true) : "other";
}

/**
 * Returns the content-free command class for an `exec` tool call (or its
 * `bash` alias), or undefined for every other tool.
 */
export function resolveDiagnosticExecClass(
  toolName: string | undefined,
  params: unknown,
): DiagnosticExecCommandClass | undefined {
  if (toolName !== "exec" && toolName !== "bash") {
    return undefined;
  }
  const command =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as { command?: unknown }).command
      : undefined;
  return classifyExecCommand(command);
}
