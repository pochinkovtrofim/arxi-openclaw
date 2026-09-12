# GitHub / PRs

Read when creating or managing GitHub issues, pull requests, reviews, or landing. Paths and commands in this document are repository-root
relative unless explicitly stated otherwise. The root AGENTS.md Arxi execution
and authorization rules apply to every example and linked skill.

- Team-session commits and PRs visibly credit only consented, verified profile-backed humans in authoritative contribution order; preserve exact co-author trailers and end PRs with the canonical team-session backlink when available.
- When creating a GitHub item, read `CONTRIBUTING.md` and its applicable issue form or PR template; consult `.github/CODEOWNERS` for review routing. Preserve template and evidence requirements.
- Issue first for bugs, user-facing features, architecture/product decisions, or work needing durable discussion. Bounded maintainer-requested refactor may go direct; agent decides whether an issue adds value. PRs use the template, link context, and keep durable problem/impact/evidence sections.
- Route support to Discord and security through `SECURITY.md`. Use listed maintainer areas/`CODEOWNERS`; never guess mentions.
- Use `$openclaw-pr-maintainer` immediately for maintainer-side OpenClaw issue/PR review, triage, duplicates, labels, comments, close, land, or evidence. Contributor PR creation/refresh follows the requested contributor workflow; linked refs alone do not require maintainer archive tooling.
- Inspect checkout status before changing refs. Preserve unrelated work and use the Arxi task worktree; do not pull/rebase a busy checkout.
- PR refs: `gh pr view/diff` or `gh api`, not web search. Prefer `gitcrawl` for maintainer discovery; missing/stale `gitcrawl` falls through to live `gh`, not contributor setup. Verify live with `gh` before mutation.
- Bare issue/PR URL/number: inspect live and take the efficient maintainer path; switch branches/refs when useful.
- No unsolicited PR labels/retitles/rebases/fixups/landing. Comments/reviews ok only for reviewable findings, pre-merge proof, or close/duplicate reason after explicit close/sweep/landing request.
- A named-item close request authorizes that item. Closing associated issues/PRs
  requires explicit cluster/sweep authority; otherwise report the related items
  as candidates. Under that authority, close only directly associated items with
  verified rationale, preserving any requested exceptions.
- Do not leave associated issues open for hypothetical future repros. Close with rationale; ask for a new issue or reopen only if concrete new evidence appears. Close comment states: decision, why, supported alternative, and what evidence would change the decision.
- Search related issues/PRs when needed to resolve the task. Close proven
  duplicates or fixed siblings only within explicit close/sweep authority;
  otherwise report useful related findings without inventing a follow-up quota.
- PR superseded by `main`: when closure is authorized and code proof shows `main` already has same-or-better behavior, comment canonical commit/PR + focused proof, then close. Bar high: inspect PR diff, current code/tests, linked issue, caller/sibling path. If unsure, leave open.
- Issue/PR numbers need a short summary every time; assume the reader has not opened or read them.
- Before presenting a batch of issues/PRs, verify live state and current `main` (subagents ok); omit closed/fixed items, and comment+close items already fixed on `main` when maintainer action is authorized.
- Generic triage and landing shortlists: exclude PRs authored by maintainers with broad repository access until 14 days after creation; only a named PR or explicit request for maintainer-owned work overrides this gate.
- When posting a review is authorized, put actionable findings on the PR and report its URL. Otherwise deliver the review in chat.
- Issue/PR final answer: last line is the full GitHub URL.
- PR verification: before merge, post land-ready work done, exact remote
  commands and host, the upstream CI/Testbox IDs or Arxi retained server receipt
  as applicable, before/after proof when used, and known proof gaps.
- Issue fixed on `main`, when acting under landing/`ship`/close/sweep authority: search duplicates, comment proof + canonical commit/PR/release, then close. Without that authority, report it instead of closing unsolicited.
- After PR merge/ship: concise prose recap, not a bullet pile; cover behavior, key surface, proof, and issue/PR state. Mention follow-ups only when concrete relevant findings remain; do not start a new refactor search at closeout.
- Public GH comments: show draft in chat first, unless the user explicitly asked to post/comment/reply/close/merge/land — under that explicit authority, once changes/proof exist, post the review/proof/commit comment without re-asking.
- Representing user: if user already has a comment/thread for the point, update/reply there when possible; avoid duplicate PR/issue comments.
- No surprise GH writes: chat must mention every posted/updated public comment with URL.
- GH comments with backticks, `$`, or shell snippets: use heredoc/body file, not inline double-quoted `--body`.
- PR create: real body required. Use the current template: `What Problem This Solves`, `Why This Change Was Made`, `User Impact`, and `Evidence`; include visible refs, behavior, and validation.
- Upstream only (Arxi has no hosted CI): PR create races GitHub's merge-ref computation and can silently drop or kill the pull_request CI run. Prevention: `gh pr create --draft`, poll `mergeable` non-null, then `gh pr ready`; verify CI attached to the head SHA — if missing, the hourly `pr-ci-sweeper` re-fires it, or close/reopen.
- PR create/refresh: keep PR branches takeover-ready. Use a branch maintainers can push to, or for fork PRs ensure `maintainer_can_modify` / GitHub's `Allow edits by maintainers` is enabled unless explicitly told otherwise or GitHub's Actions/secrets warning makes that unsafe.
- Contributor PRs: parsed context requires authored `What Problem This Solves` and `Evidence` sections. Do not require field-level proof forms; reviewers inspect code, tests, and CI for correctness.
- PR/issue images/video: upload with `gh --attach` when the installed `gh` exposes it, otherwise the GitHub user-attachments endpoint; uploads are permanent and need no browser/computer use. Never push proof assets to any product repo branch; do not commit `.github/pr-assets`. Commands, video rules, error semantics, transcode, and artifact fallback: `$openclaw-pr-maintainer`.
- Upstream CI polling: exact SHA, relevant checks only, minimal fields. Skip routine noise (`Auto response`, `Labeler`, docs agents, performance/stale). Logs only after failure/completion or concrete need. Never `gh run watch`; its 3s polling exhausts API quota. Use sparse GraphQL rollups. Filter `gh run list` by workflow/branch/commit; broad JSON lists can exceed relay caps. Exact-SHA fallback dispatches require the full 40-character SHA.
- Upstream CI waits: `node scripts/watch-pr-ci.mjs <pr> <head-sha>` — prechecks mergeable (CONFLICTING = pull_request CI cannot attach) and run attachment before polling; watchers emit every terminal state; no unbounded polls.
- Upstream agent PR landing to `main`: use the repo-native `scripts/pr` wrapper
  and the `$openclaw-pr-maintainer` mechanics. This upstream-only path must not
  be used for the Arxi fork; use the exact-head server receipt and expected-head
  merge guard in root `AGENTS.md` (Arxi execution and landing).
- Non-main PRs: never `scripts/pr prepare-run`/`merge-run` (they diff against `main`); the exact procedure, plus throttle-lock recovery, lives in `$openclaw-pr-maintainer`.
- Upstream main-bound workflow dispatch: resolve server `main` SHA immediately
  before dispatch. The Arxi fork must not dispatch disabled workflows.
