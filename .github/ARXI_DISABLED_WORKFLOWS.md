# Workflows disabled in the Arxi fork

The following upstream workflows are disabled in GitHub for
`pochinkovtrofim/arxi-openclaw`. They are not product acceptance evidence for
the hosted Arxi Linux runtime and must not be re-enabled by routine maintenance
or future implementation threads.

## Upstream CI and test infrastructure

- `ci-build-artifacts-testbox.yml`
- `ci-check-arm-testbox.yml`
- `ci-check-testbox.yml`
- `install-smoke.yml`
- `node22-compat.yml`
- `openclaw-performance.yml`
- `openclaw-scheduled-live-checks.yml`
- `qa-live-transports-convex.yml`
- `real-behavior-proof.yml`
- `sandbox-common-smoke.yml`
- `vitest-cache-warm.yml`
- `workflow-sanity.yml`

`ci.yml` is manual-only in source. It may be enabled in GitHub only after that
manual-only revision is on `main`; it is never an automatic Arxi gate.

## UI and native products Arxi does not ship

- `codeql-android-critical-security.yml`
- `codeql-macos-critical-security.yml`
- `control-ui-locale-refresh.yml`
- `ios-periphery-comment.yml`
- `ios-periphery.yml`
- `linux-app.yml`
- `live-media-runner-image.yml`
- `macos-periphery.yml`
- `mantis-telegram-desktop-proof-dispatch.yml`
- `native-app-locale-refresh.yml`
- `shared-openclawkit-periphery.yml`
- `website-installer-sync.yml`

## Upstream repository, release, and publication automation

- `auto-response.yml`
- `clawsweeper-dispatch.yml`
- `dated-todo-sweep.yml`
- `docs-agent.yml`
- `docs-external-links.yml`
- `docs-sync-publish.yml`
- `docs-translate-trigger-release.yml`
- `docs.yml`
- `labeler.yml`
- `maintainer-command-reactions.yml`
- `openclaw-stable-main-closeout.yml`
- `plugin-init-scaffold-validation.yml`
- `plugin-npm-release.yml`
- `pr-ci-sweeper.yml`
- `stale.yml`

The active automatic verification boundary is `arxi-ci.yml` plus generic
security workflows: `opengrep-precise.yml`, `codeql.yml`,
`dependency-guard.yml`, and `security-sensitive-guard.yml`. Manual release or
diagnostic workflows can remain available because they do not run on ordinary
Arxi pushes or pull requests.
