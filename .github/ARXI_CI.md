# Ro fork verification

This repository is a Ro runtime fork, not a distribution of every OpenClaw
product surface. GitHub Actions do not run for Ro: the former `Ro fork gate`
workflow is archived in `.github/workflows-disabled/arxi-ci.yml`. Fork changes
are verified on Ro's build host by the monorepo's `checks.mjs` suites `fork`
and `fork-ops` (`ops/release/fork-tests.sh`), and focused commands run there
through the monorepo's `ops/scripts/openclaw-fork-run.sh`. Those suites cover
only the Linux runtime and public seams that the composed Ro platform ships:

- production type checking for shipped core and extension code;
- the direct Telegram context, durable outbound, OpenAI capability projection,
  active-model catalog projection, and catalog-worker plugin-metadata tests
  consumed by Ro;
- model-authored message-action correlation into the durable owner-channel
  adapter, including the negative operator-send classification;
- requester-scoped MCP identity propagation, resolver revalidation, and the
  gateway/plugin seams used by the Google Workspace capability;
- the pinned Codex app-server package, protocol projection, dynamic/native tool
  lifecycle, authenticated MCP bridge, and model-call diagnostics;
- credential custody, managed-agent ownership, diagnostic trace propagation,
  and the atomic suspend/wake lifecycle used by the host;
- cron tool, schedule, caller-scope and Automation tests, and structured
  heartbeat delivery;
- the monorepo's Ops guest tests (`ops/tests/*.openclaw.test.ts`), run inside
  the fork against its built packages (`fork-ops`);
- dependency and lockfile consistency through the frozen install.

The upstream `CI` workflow is disabled in the Ro GitHub repository, as are
the Testbox build/check jobs, Control UI, browser UI, native
macOS/iOS/Linux apps, generic QA Lab, generic agentic/Gateway/CLI, Docker,
bundle, and workflow-self-test matrices. Those jobs qualify upstream
products Ro does not ship and therefore are not evidence for Ro.
The exact GitHub-disabled set is recorded in `ARXI_DISABLED_WORKFLOWS.md`.
The focused source-owned agent-runner E2E skips upstream's private-QA build;
Ro neither ships nor uses that artifact, and the test owns its fixtures.

Product user scenarios are accepted only through the composed platform: the
platform's focused Go boundary tests, ops artifact/golden/deployment checks,
and the real production Telegram + ChatGPT canary. A future fork change that
adds a shipped Ro seam must add its direct behavior check to
`ops/release/fork-tests.sh` and its line here. It must not re-enable the
upstream full matrix by default.
