// State format fingerprint tests cover which sources gate Ro's offline repair.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeStateFormat,
  isStateFormatSource,
  listStateFormatSources,
} from "../../scripts/arxi-state-format.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("arxi-state-format", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function tree(files: Record<string, string>): string {
    const root = tempDirs.make("arxi-state-format-");
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    }
    return root;
  }

  it("selects migration, doctor, schema and format-version sources only", () => {
    const root = tree({
      "package.json": "{}\n",
      "src/state/openclaw-agent-db-contract.ts": "export const X = 1;\n",
      "src/commands/doctor-health.ts": "",
      "src/infra/state-migrations.media.ts": "",
      "extensions/memory-core/src/dreaming-repair.ts": "",
      "src/memory/root-memory-files.ts": "",
      "src/plugin-state/plugin-state-store.ts": "",
      "src/plugin-sdk/memory-core-bundled-runtime.ts": "",
      "src/cron/service/managed-flow-obligation-repair.ts": "",
      "src/plugin-sdk/channel-config.ts": "",
      "src/infra/sqlite-user-version.ts": "",
      "src/config/legacy-private-network-migration.ts": "",
      "src/commands/migrate/apply.ts": "",
      "extensions/memory-core/src/memory/manager-reindex-state.ts": "",
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
      "src/agents/auth-profiles/constants.ts",
      "src/commands/doctor-health.ts",
      "src/commands/migrate/apply.ts",
      "src/config/legacy-private-network-migration.ts",
      "src/cron/service/managed-flow-obligation-repair.ts",
      "src/infra/sqlite-user-version.ts",
      "src/infra/state-migrations.media.ts",
      "src/media/store.ts",
      "src/memory/root-memory-files.ts",
      "src/plugin-sdk/memory-core-bundled-runtime.ts",
      "src/plugin-state/plugin-state-store.ts",
      "src/state/openclaw-agent-db-contract.ts",
    ]);
    expect(isStateFormatSource("src/gateway/doctor/index.ts", () => "")).toBe(true);
  });

  it("adds the modules doctor imports directly, but not theirs", () => {
    const root = tree({
      "src/commands/doctor-maintenance.ts": [
        'import { GatewayLockError } from "../infra/gateway-lock.js";',
        'import type { X } from "../agents/agent-scope.js";',
        'export { y } from "./shared/format.js";',
        'const z = await import("../plugins/loader.js");',
        'import { sdk } from "openclaw/plugin-sdk/channel-config";',
        'import "./side-effect.js";',
        'import { helper } from "./doctor-maintenance.test-helpers.js";',
        'import { external } from "node:fs";',
        "",
      ].join("\n"),
      "src/infra/gateway-lock.ts": 'import { deep } from "./deep.js";\n',
      "src/infra/deep.ts": "",
      "src/agents/agent-scope.ts": "",
      "src/commands/shared/format.ts": "",
      "src/plugins/loader.ts": "",
      "src/plugin-sdk/channel-config.ts": "",
      "src/commands/side-effect.ts": "",
      "src/commands/doctor-maintenance.test-helpers.ts": "",
    });
    expect(listStateFormatSources(root)).toEqual([
      "src/agents/agent-scope.ts",
      "src/commands/doctor-maintenance.ts",
      "src/commands/shared/format.ts",
      "src/commands/side-effect.ts",
      "src/infra/gateway-lock.ts",
      "src/plugin-sdk/channel-config.ts",
      "src/plugins/loader.ts",
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

  it("covers this repository's schema contracts, doctor and memory index versions", () => {
    const sources = new Set(listStateFormatSources(repoRoot));
    for (const required of [
      "package.json",
      "scripts/arxi-state-format.mjs",
      "src/state/openclaw-state-db-contract.ts",
      "src/state/openclaw-agent-db-contract.ts",
      "src/state/openclaw-agent-session-snapshots-schema.ts",
      "src/infra/state-migrations.media-persistence.ts",
      "src/infra/arxi-credential-schema-migration.ts",
      "src/config/sessions/startup-migration.ts",
      "src/commands/doctor.ts",
      "src/flows/doctor-health.ts",
      "src/infra/gateway-lock.ts",
      "src/plugin-sdk/memory-core-bundled-runtime.ts",
      "extensions/memory-core/src/dreaming-repair.ts",
      "extensions/memory-core/src/short-term-promotion-artifacts.ts",
      "src/memory/root-memory-files.ts",
      "src/agents/auth-profiles/constants.ts",
      "packages/memory-host-sdk/src/host/markdown-chunks.ts",
      "extensions/memory-core/src/memory/manager-reindex-state.ts",
    ]) {
      expect(sources, required).toContain(required);
    }
    expect([...sources].filter((source) => /\.test\./u.test(source))).toEqual([]);
  });
});
