# Tooling Gotchas

Read when a relevant shell, Git, or GitHub command needs troubleshooting. Paths and commands in this document are repository-root
relative unless explicitly stated otherwise. The root AGENTS.md Arxi execution
and authorization rules apply to every example and linked skill.

Mechanics only; policy lives above.

- `gh`: `gh pr view` takes the branch positionally (no `--head`). `gh pr diff` has no `--stat`; use `gh pr view --json changedFiles,additions,deletions` or `git diff --stat`. `gh pr checks --json` uses `link`, not `detailsUrl`. `gh run view --json` uses `attempt`, not `attemptNumber`; reruns need `gh run view <run> --attempt <n>` (default output may show the prior attempt). `gh --jq` is not standalone `jq` (no `--arg`); pipe JSON to `jq`. `gh api --paginate '<endpoint>' | jq -s ...`; gh `--slurp` may emit nothing and forbids `--jq`/`--template`.
- zsh: quote `gh api` endpoints containing `?` or brackets and quote command globs; unmatched patterns abort before the tool runs. Don't use `path` as a variable; it rewrites `$PATH`. Git object paths: `${sha}:path`; `$sha:path` invokes parameter modifiers. File lists into tools: `--name-only -z | xargs -0`; zsh scalars don't word-split, and a zero-file run exits 0 looking clean.
- git: shared checkout — serialize `git fetch`; on ref-lock failure, re-read the ref before retry. Fetch/pull yielding without completion: inspect/stop only the owned process before retry; never overlap retries. Main locked elsewhere: detach at `origin/main`, then create the task branch.
- Upstream GitHub Actions: resolve workflow files from `.github/workflows` or
  API. In the Arxi fork, `.github/workflows-disabled/` is reference-only and
  must never be enabled or dispatched.
- Shell/exec: yielded exec — retain the returned session id before polling; never blind-retry. Nested remote shell: avoid local `$()` expansion; use remote-safe validation. Merge guard shells start `set -euo pipefail`; a failed `[[ ... ]]` alone does not stop a later merge command.
- `rg`: options/globs before `--`; `--` immediately before a leading-dash pattern only.
- macOS `find` has no `-printf`; use `-print0` plus `stat`.
- Path formatter: `node_modules/.bin/oxfmt`; `pnpm exec` may reconcile workspace deps.
- `scripts/pr` operational gotchas (guard SHAs, token unsets, artifact enums, post-merge `cd`): `$openclaw-pr-maintainer`.
