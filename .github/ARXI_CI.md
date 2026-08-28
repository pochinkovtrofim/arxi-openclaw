# Arxi fork verification

This repository is an Arxi runtime fork, not a distribution of every OpenClaw
product surface. Ordinary pull requests and `main` pushes are gated by
`Arxi fork gate`, which verifies only the Linux runtime and public seams that
the composed Arxi platform ships:

- the exact Node runtime build used by the owner-channel artifact;
- production type checking for shipped core and extension code;
- formatting and lint for changed Telegram, Codex, outbound-delivery,
  runtime-plan, channel-contract, and plugin-SDK source;
- the direct Telegram context, durable outbound, OpenAI capability projection,
  active-model catalog projection, and catalog-worker plugin-metadata tests
  consumed by Arxi;
- model-authored message-action correlation into the durable owner-channel
  adapter, including the negative operator-send classification;
- the public Telegram planning export and plugin-SDK/package boundary;
- dependency and lockfile consistency through the frozen install;
- workflow validity. Diff-scoped OpenGrep, CodeQL, dependency review, and
  secret/security guards remain separate automatic security workflows.

The upstream `CI` workflow remains available for an explicit manual diagnostic,
but is disabled as an automatic workflow in the Arxi GitHub repository. The
same applies to automatic Testbox build/check jobs, Control UI, browser UI,
native macOS/iOS/Linux apps, generic QA Lab, generic agentic/Gateway/CLI,
Docker, bundle, and workflow-self-test matrices. Those jobs qualify upstream
products Arxi does not ship and therefore are not evidence for Arxi.
The exact GitHub-disabled set is recorded in `ARXI_DISABLED_WORKFLOWS.md`.
The focused source-owned agent-runner E2E skips upstream's private-QA build;
Arxi neither ships nor uses that artifact, and the test owns its fixtures.

Product user scenarios are accepted only through the composed platform: the
platform's focused Go boundary tests, ops artifact/golden/deployment checks,
and the real production Telegram + ChatGPT canary. A future fork change that
adds a shipped Arxi seam must add its exact files and direct behavior check here;
the narrow shipped-file allowlist fails closed for every other change under a
production source root. It must not re-enable the upstream full matrix by default.
