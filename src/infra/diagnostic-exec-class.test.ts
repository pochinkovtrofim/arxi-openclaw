// Covers the content-free exec command class used by tool diagnostics.
import { describe, expect, it } from "vitest";
import {
  classifyExecCommand,
  EXEC_COMMAND_CLASSES,
  resolveDiagnosticExecClass,
} from "./diagnostic-exec-class.js";

describe("classifyExecCommand", () => {
  it.each([
    ["ls -la /home/owner/private", "ls"],
    ["grep -rn secret-token .", "grep"],
    ["  curl -s https://example.invalid/path?q=1", "curl"],
    ["cat notes.txt | wc -l", "cat"],
    ["git status && git diff", "git"],
    ["cd /srv/app && npm test", "cd"],
    ["jq .items[0] data.json", "jq"],
    ["pdftotext report.pdf -", "pdftotext"],
    ["yt-dlp -x clip", "yt-dlp"],
  ])("keeps an allowlisted first word: %s", (command, expected) => {
    expect(classifyExecCommand(command)).toBe(expected);
  });

  it.each([
    "my-private-script --flag",
    "./deploy.sh production",
    "Ls",
    "python3.12 job.py",
    "owner_named_binary",
  ])("maps an unlisted first word to other: %s", (command) => {
    expect(classifyExecCommand(command)).toBe("other");
  });

  it.each([
    ["/usr/bin/python3 script.py", "python3"],
    ["/opt/homebrew/bin/ffmpeg -i in.mov out.mp4", "ffmpeg"],
    ["'/usr/bin/sqlite3' db.sqlite .tables", "sqlite3"],
    ['"python3" -c "print(1)"', "python3"],
    ["LANG=C.UTF-8 TZ=UTC date +%F", "date"],
    ["/home/owner/bin/secret-tool", "other"],
  ])("strips quotes, assignments and directory prefixes: %s", (command, expected) => {
    expect(classifyExecCommand(command)).toBe(expected);
  });

  it.each([
    ["sh -c 'git log --oneline'", "git"],
    ['bash -lc "cd /tmp && ls"', "cd"],
    ["/bin/bash -c 'python3 -c \"print(1)\"'", "python3"],
    ["zsh -c 'private-binary arg'", "other"],
    ['bash -c "$HOME/run.sh"', "other"],
    ["bash -c", "other"],
    ["sh -c 'bash -c \"ls\"'", "other"],
    ["bash -o pipefail -c 'ls'", "other"],
    ["bash run.sh", "bash"],
    ["sh", "sh"],
  ])("unwraps only trivially parseable shell wrappers: %s", (command, expected) => {
    expect(classifyExecCommand(command)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "$EDITOR file",
    "`which python3` x",
    "\\ls",
    "(cd /tmp && ls)",
    "{ ls; }",
    "'unterminated",
    "python3$IFS-c",
    "A=1 B=2 C=3 D=4 E=5 F=6 G=7 H=8 I=9 ls",
  ])("classifies syntax that needs a shell to resolve as other: %j", (command) => {
    expect(classifyExecCommand(command)).toBe("other");
  });

  it("is other for anything that is not a string", () => {
    expect(classifyExecCommand(undefined)).toBe("other");
    expect(classifyExecCommand(["ls"])).toBe("other");
    expect(classifyExecCommand({ command: "ls" })).toBe("other");
  });

  it("never returns text outside the allowlist", () => {
    const allowed = new Set<string>([...EXEC_COMMAND_CLASSES, "other"]);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 /'\"-=._$|;&()\\`";
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let sample = 0; sample < 5_000; sample++) {
      let command = "";
      const length = next() % 40;
      for (let index = 0; index < length; index++) {
        command += alphabet[next() % alphabet.length];
      }
      expect(allowed.has(classifyExecCommand(command))).toBe(true);
    }
  });
});

describe("resolveDiagnosticExecClass", () => {
  it("classifies the command of exec and its bash alias only", () => {
    expect(resolveDiagnosticExecClass("exec", { command: "rg TODO src" })).toBe("rg");
    expect(resolveDiagnosticExecClass("bash", { command: "node app.js" })).toBe("node");
    expect(resolveDiagnosticExecClass("exec", { cmd: "ls" })).toBe("other");
    expect(resolveDiagnosticExecClass("exec", "ls")).toBe("other");
    expect(resolveDiagnosticExecClass("read", { command: "ls" })).toBeUndefined();
    expect(resolveDiagnosticExecClass(undefined, { command: "ls" })).toBeUndefined();
  });
});
