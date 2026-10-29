// State format fingerprint tests cover which sources gate Ro's offline repair.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedStateFormat,
  changedStateFormatSources,
  computeStateFormat,
  fileTree,
  gitTree,
  isStateFormatSource,
  listStateFormatSources,
} from "../../scripts/arxi-state-format.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("arxi-state-format", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function write(root: string, files: Record<string, string>): string {
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    }
    return root;
  }

  function tree(files: Record<string, string>) {
    return fileTree(write(tempDirs.make("arxi-state-format-"), files));
  }

  function commit(root: string, files: Record<string, string>): string {
    write(root, files);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], {
        cwd: root,
        encoding: "utf8",
      });
    git("add", "-A");
    git("commit", "-qm", "c");
    return git("rev-parse", "HEAD").trim();
  }

  it("selects migrations, doctor, stored shapes and format versions, not the runtime", () => {
    const root = tree({
      "package.json": "{}\n",
      "pnpm-lock.yaml": "",
      "scripts/arxi-state-format.mjs": "const FORMAT_VERSION = 1;\n",
      "qa/scenarios/doctor-flow.ts": "",
      "src/state/openclaw-agent-db-schema.ts": "",
      "src/state/openclaw-agent-db-lease.ts": "",
      "src/commands/doctor-health.ts": "",
      "src/infra/state-migrations.media.ts": "",
      "src/infra/update-recovery.ts": "",
      "src/infra/sqlite-files.ts": "",
      "extensions/memory-core/src/dreaming-repair.ts": "",
      "extensions/memory-core/src/memory/manager-reindex-state.ts": "",
      "extensions/memory-core/src/memory/hybrid.ts": "",
      "packages/memory-host-sdk/src/host/markdown-chunks.ts": "",
      "src/memory/root-memory-files.ts": "",
      "src/config/sessions/session-accessor.ts": "",
      "src/config/sessions/session-entry-state-format.ts": "",
      "src/config/sessions/version.ts": "",
      "src/config/sessions/conversation.ts": "",
      "src/config/sessions/store-entry-shape.ts":
        "throw new SessionStoreMigrationRequiredError(field);\n",
      "src/state/openclaw-state-db-maintenance.ts": "",
      "src/state/openclaw-state-db.ts": "export function repairIndexesForDoctor() {}\n",
      "src/gateway/hint.ts": 'const hint = "run openclaw doctor --fix";\n',
      "src/plugin-sdk/memory-core-bundled-runtime.ts": "",
      "src/cron/normalize.ts": "",
      "src/cron/service/managed-flow-obligation-repair.ts": "",
      "src/config/legacy-private-network-migration.ts": "",
      "src/commands/migrate/apply.ts": "",
      "src/agents/auth-profiles/constants.ts": "export const AUTH_STORE_VERSION = 1;\n",
      "src/media/store.ts": "const AGENT_MEDIA_SCHEMA_VERSION: number = 17;\n",
      "src/gateway/server.ts": "export const VERSION = 1;\n",
      "src/state/openclaw-agent-db.test.ts": "",
      "src/commands/doctor.test-helpers.ts": "",
      "test/doctor-e2e.ts": "",
      "docs/migration.md": "",
      "src/state/README.md": "",
      "node_modules/x/doctor.js": "",
      "dist/doctor.js": "",
      "ui/src/doctor.ts": "",
    });
    expect(listStateFormatSources(root)).toEqual([
      "extensions/memory-core/src/dreaming-repair.ts",
      "extensions/memory-core/src/memory/manager-reindex-state.ts",
      "package.json",
      "packages/memory-host-sdk/src/host/markdown-chunks.ts",
      "src/agents/auth-profiles/constants.ts",
      "src/commands/doctor-health.ts",
      "src/commands/migrate/apply.ts",
      "src/config/legacy-private-network-migration.ts",
      "src/config/sessions/session-entry-state-format.ts",
      "src/config/sessions/store-entry-shape.ts",
      "src/config/sessions/version.ts",
      "src/infra/state-migrations.media.ts",
      "src/infra/update-recovery.ts",
      "src/media/store.ts",
      "src/state/openclaw-agent-db-schema.ts",
      "src/state/openclaw-state-db-maintenance.ts",
      "src/state/openclaw-state-db.ts",
    ]);
    expect(isStateFormatSource("src/gateway/doctor/index.ts", () => "")).toBe(true);
  });

  it("adds the repairs doctor imports directly, but not its shared runtime or their imports", () => {
    const root = tree({
      "src/commands/doctor-maintenance.ts": [
        'import { GatewayLockError } from "../infra/gateway-lock.js";',
        'import type { X } from "../agents/agent-scope.js";',
        'export { y } from "./shared/session-repair.js";',
        'const z = await import("../plugins/plugin-recovery.js");',
        'import { sdk } from "openclaw/plugin-sdk/channel-backup";',
        'import { capture } from "../infra/update-baseline-capture.js";',
        'import { helper } from "./doctor-maintenance.test-helpers.js";',
        'import { external } from "node:fs";',
        "",
      ].join("\n"),
      "src/infra/gateway-lock.ts": "",
      "src/agents/agent-scope.ts": "",
      "src/commands/shared/session-repair.ts":
        'import { deep } from "../../plugins/deep-repair.js";\n',
      "src/plugins/deep-repair.ts": "",
      "src/plugins/plugin-recovery.ts": "",
      "src/plugin-sdk/channel-backup.ts": "",
      "src/infra/update-baseline-capture.ts": "",
      "src/commands/doctor-maintenance.test-helpers.ts": "",
    });
    expect(listStateFormatSources(root)).toEqual([
      "src/commands/doctor-maintenance.ts",
      "src/commands/shared/session-repair.ts",
      "src/infra/update-baseline-capture.ts",
      "src/plugin-sdk/channel-backup.ts",
      "src/plugins/plugin-recovery.ts",
    ]);
  });

  it("changes only with the fingerprinted sources", () => {
    const files = {
      "src/state/openclaw-agent-db-contract.ts":
        "export const OPENCLAW_AGENT_SCHEMA_VERSION = 24;\n",
      "src/gateway/server.ts": "export {};\n",
      "src/state/openclaw-agent-db.test.ts": "it();\n",
    };
    const base = computeStateFormat(tree(files));
    expect(base).toEqual({
      schema: 1,
      stateFormat: expect.stringMatching(/^[0-9a-f]{64}$/),
      files: 1,
    });
    expect(computeStateFormat(tree(files))).toEqual(base);
    expect(
      computeStateFormat(
        tree({
          ...files,
          "src/gateway/server.ts": "export const x = 1;\n",
          "src/state/openclaw-agent-db.test.ts": "",
        }),
      ),
    ).toEqual(base);
    expect(
      computeStateFormat(
        tree({
          ...files,
          "src/state/openclaw-agent-db-contract.ts":
            "export const OPENCLAW_AGENT_SCHEMA_VERSION = 25;\n",
        }),
      ).stateFormat,
    ).not.toBe(base.stateFormat);
    expect(
      computeStateFormat(
        tree({ ...files, "src/gateway/session-store.ts": "const SESSION_STORE_VERSION = 2;\n" }),
      ).stateFormat,
    ).not.toBe(base.stateFormat);
  });

  it("covers this repository's schema contracts, migrations, doctor and memory index versions", () => {
    const sources = new Set(listStateFormatSources(fileTree(repoRoot)));
    for (const required of [
      "package.json",
      "src/state/openclaw-state-db-contract.ts",
      "src/state/openclaw-agent-db-contract.ts",
      "src/state/openclaw-schema-versions.ts",
      "src/state/openclaw-agent-session-snapshots-schema.ts",
      "src/infra/state-migrations.media-persistence.ts",
      "src/infra/arxi-credential-schema-migration.ts",
      "src/infra/update-recovery-baseline-capture.ts",
      "src/config/sessions/startup-migration.ts",
      "src/config/sessions/session-entry-state-format.ts",
      "src/config/sessions/store-entry-shape.ts",
      "src/config/sessions/version.ts",
      "src/state/openclaw-state-db.ts",
      "src/state/openclaw-state-db-maintenance.ts",
      "src/state/openclaw-agent-db-maintenance.ts",
      "src/commands/doctor.ts",
      "src/commands/doctor/cron/store-repair.ts",
      "src/flows/doctor-health.ts",
      "extensions/memory-core/src/dreaming-repair.ts",
      "src/agents/auth-profiles/constants.ts",
      "packages/memory-host-sdk/src/host/markdown-chunks.ts",
      "extensions/memory-core/src/memory/manager-reindex-state.ts",
    ]) {
      expect(sources, required).toContain(required);
    }
    // The runtime that only reads stored state, and this script's own rules.
    for (const runtime of [
      "pnpm-lock.yaml",
      "scripts/arxi-state-format.mjs",
      "src/cron/normalize.ts",
      "src/infra/gateway-lock.ts",
      "src/config/sessions/session-accessor.ts",
      "extensions/memory-core/src/memory/hybrid.ts",
    ]) {
      expect(sources, runtime).not.toContain(runtime);
    }
    expect([...sources].filter((source) => /\.test\./u.test(source))).toEqual([]);
  });

  it("reads a commit as the build reads its exported source and names a change's files", () => {
    const root = tempDirs.make("arxi-state-format-git-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const files = {
      "src/state/openclaw-agent-db-contract.ts":
        "export const OPENCLAW_AGENT_SCHEMA_VERSION = 24;\n",
      "src/commands/doctor-health.ts": 'import { a } from "../plugins/plugin-recovery.js";\n',
      "src/plugins/plugin-recovery.ts": "export const a = 1;\n",
      "src/gateway/server.ts": "export {};\n",
      "test/doctor.ts": "",
    };
    const base = commit(root, files);
    fs.symlinkSync("server.ts", path.join(root, "src/gateway/doctor-link.ts"));
    const same = commit(root, { "src/gateway/server.ts": "export const x = 1;\n" });
    expect(computeStateFormat(gitTree(root, base))).toEqual(computeStateFormat(tree(files)));
    expect(changedStateFormatSources(gitTree(root, base), gitTree(root, same))).toEqual([]);
    fs.rmSync(path.join(root, "src/gateway/doctor-link.ts"));
    const head = commit(root, {
      "src/plugins/plugin-recovery.ts": "export const a = 2;\n",
      "src/cron/legacy-store.ts": "",
    });
    expect(changedStateFormatSources(gitTree(root, base), gitTree(root, head))).toEqual([
      "src/cron/legacy-store.ts",
      "src/plugins/plugin-recovery.ts",
    ]);
    // A build of base hashed under the rules it carried.
    expect(changedStateFormat(root, base, same)).toEqual([]);
    const rules = commit(root, { "scripts/arxi-state-format.mjs": "// rules\n" });
    expect(changedStateFormat(root, head, rules)).toEqual(["scripts/arxi-state-format.mjs"]);
  });
});
