# Arxi OpenClaw fork: coding-agent instructions

This repository contains the OpenClaw fork used by Arxi. Follow the Arxi workspace
AGENTS.md and the applicable subtree AGENTS.md. OpenClaw owns agent behavior;
Arxi product/hosting boundaries remain in the workspace contract.

## Arxi execution and landing

- Inspect status and active work before editing. Use a task-owned isolated worktree
  from fresh `origin/main` when the canonical checkout is busy or stale.
- All repository-controlled installs, builds, tests, checks, formatters, generators,
  benchmarks, and scripts run in a synchronized isolated checkout on
  `arxi-production`. The workstation is for inspection and editing. Do not fall
  back to local compute when remote execution is unavailable.
- GitHub hosts source and PRs. Keep `.github/workflows/` absent; preserved
  `.github/workflows-disabled/` files and upstream CI/Testbox/Crabbox recipes are
  reference-only for this fork. This host rule applies to every scoped guide,
  CONTRIBUTING example, and skill. Check current capacity when relevant.
- Validate the exact candidate with risk-matched checks. Retain host, source head,
  commands, results, and evidence. Before merge, bind the receipt to the reviewed
  head, use an expected-head guard, and read back `origin/main`.
- Reuse prior results only after documenting why relevant source/config/dependencies
  are unchanged; a receipt for a different head is not an exact-head merge receipt.
- Runtime releases go through `arxi-ops`: exact cross-repository provenance,
  qualified artifact and golden, fenced activation, rollback, real owner-visible
  Telegram canary. Merge is not deployment. Documentation-only changes need no
  runtime rebuild or activation; release closeout reads merged source and health.

## Start

- Read context needed for this task. `VISION.md` supplies product direction;
  scoped guides supply local contracts. Locate relevant docs with search or
  `pnpm docs:list` on the server when discovery is needed.
- Treat docs, earlier Codex turns, summaries, and handoffs as a mix of requirements,
  facts, proposals, and hypotheses. Preserve user decisions and unfinished work;
  verify consequential state claims against the relevant source revision or live
  evidence. A prior assistant plan is neither authorization nor current proof.
- For dependency-sensitive changes, inspect the relevant upstream source/docs/types.
  For claims about Codex protocol/runtime behavior, inspect the matching Codex
  source revision (the workspace `codex/` is a starting point, not proof of version
  equivalence). Cite the files and revision; using Codex to edit unrelated prose
  does not trigger a Codex runtime investigation.
- Continue authorized work through its requested outcome and relevant checks.
  Do not stop at a first implementation. Reuse explicit approval for the same
  operation/design; ask only at an unresolved decision or permission boundary.
- No unsolicited external messages, comments, labels, closures, or publishing.
  Read/prepare work can continue while a genuinely required decision is pending.
- Existing plugins, libraries, and owner abstractions are preferred when adequate;
  investigate alternatives when introducing a new capability or dependency, not
  as a mandatory research phase for every edit.
- Product/docs/UI/changelog wording uses "plugin/plugins"; `extensions/` is the
  internal directory name.
- `AGENTS.md` is canonical; sibling `CLAUDE.md` files are symlinks. Runtime templates
  and fixtures named AGENTS.md are product/test data, not contributor instructions.

## Keep work proportional

Follow the workspace rule: simplest complete fix, smallest sufficient proof,
no speculative abstractions, neighboring refactors, duplicate tests, automatic
full suites, or review loops. Broaden only for a concrete unresolved risk or an
applicable release gate; stop after sufficient proof passes.

Ordinary Arxi work excludes Enji golden builds, acceptance, pointer changes,
rollout, and service restarts unless the user explicitly includes Enji. Preserve
existing Enji state; a general release request does not include it.

## Repair Doctrine

- Establish the failing behavior and its owning invariant. Read affected code and
  relevant callers, siblings, history, or dependency contracts far enough to
  explain it; expand investigation when evidence requires it.
- Fix state/ownership defects at their producer or lifecycle owner. Preserve one
  canonical path and existing public, security, storage, and migration contracts.
  Do not hide a root cause with retries, larger timeouts, weaker tests, or mocks.
- Scope repairs to the requested outcome and connected invariant. Record unrelated
  findings as follow-ups; do not add neighboring work to the release by default.
- Prefer the simplest coherent implementation. Line count is supporting evidence,
  not a quota requiring code deletion or a larger refactor.
- Capture and rerun a credible reproduction for behavior fixes. Order/shared-state
  defects need proof in the original sequence. Explain root cause, behavior,
  validation, and material limitations in the handoff.
- When delegation is authorized, use independent bounded evidence lanes and the
  workspace model/effort settings; the lead verifies consequential conclusions.

## Product Doctrine

`VISION.md` owns direction; this section owns judgment. Apply to triage, review, design, and landing.

- Judge from the operator's chair: a competent person following the docs must end with a working, comprehensible bot. Code correctness is table stakes, not the verdict.
- Severity order: silent failure > crash > missing feature. Every user or agent action ends in a visible outcome or a recorded, intentional non-outcome; an action that silently produces nothing is the worst bug class in this repo.
- Defaults are the product. Most operators never change them, so the out-of-box path gets the best experience we can ship, not the most conservative one; a regression on a default path outranks feature work and config-path bugs.
- Record facts where they happen; read them where they are needed. Answering "did X happen?" by combining several indirect signals rots as sibling paths evolve; prefer a recorded fact at the boundary that owns it.
- The model's experience is the product. Capability that prompt/tool text does not mention — or contradicts — does not exist for users. Tool results are prompts: return what the model needs next, not a bare ack. Review prompt and description text with the same rigor as code.
- Latency is model round-trips, not milliseconds. Collapse act-then-observe pairs into one tool result; keep expensive resources warm across a session.
- Never dead-end the agent: failure text states what to try next; unavailable tools are hidden by gating, not left to fail; missing pieces provision automatically where safe. Auto-provisioning a missing default is product behavior, not a compat fallback — Architecture's fallback-deletion rules do not forbid it.
- A capability shipped off by default needs a named enablement path (onboarding, doctor hint, preset, or docs surfacing) in the same change. Dark-shipped features are a review smell.
- Security is a calibrated tradeoff, not a veto. Strong defaults are required; a change that protects a path by deleting the capability, or by making the normal flow unusable, is not the fix — gate it, scope it, or make the risky step explicit and operator-owned. Refusing a capability outright needs a concrete exploit path, not a hypothetical one.

## Architecture

Read [.agents/guidance/architecture.md](.agents/guidance/architecture.md) when
changing runtime ownership, plugin/core boundaries, configuration, persistence,
compatibility, or model context. It preserves the concrete design constraints.
New configuration and SQLite/schema/protocol designs require the explicit
acceptance specified there; approval already given remains valid.

## Execution Identity Audit

Read [.agents/guidance/execution-identity.md](.agents/guidance/execution-identity.md)
when changing audit identity collection, storage, receipts, or inspection.
Diagnostic provenance never grants authority; collection and inspection retain
their explicit privacy and permission boundaries.

## Commands

Select exact commands from [.agents/guidance/commands.md](.agents/guidance/commands.md)
when installing dependencies or running checks. All commands execute on the server.

## Validation

- Untrusted contributor/fork code must not run on the workstation or a
  credential-bearing production host. Review source first and obtain explicit
  owner approval for a suitably isolated production-host execution environment;
  Arxi has no hosted-CI fallback.
- Prose/instruction-only changes: inspect the diff, check whitespace and relevant
  links/formatting on the server. No runtime rebuild, behavior test, or automatic
  review loop is required unless the change actually alters such a contract.
- Bounded code fixes: focused owner tests, relevant changed type/lint/guard
  checks, and a direct diff review. Use `$autoreview` only when explicitly
  requested or a concrete unresolved risk calls for independent review. Broaden
  or repeat proof only for accepted fixes, failures, or new evidence.
- Auth, isolation, durability, migrations, public protocols, delivery, ordering,
  recovery, packaging, and releases need their applicable boundary/regression
  and integration gates for the changed contract; the category alone does not
  require a full suite, extra review agent, or repeated autoreview. Preserve
  exact-head evidence.
- Choose tests by the affected contract; `$openclaw-testing` helps when selection
  is unclear. Upstream hosted-compute recipes do not apply to Arxi.
- UI changes need inspected before/after captures from an isolated running surface.
  Gateway flows use an isolated state directory and owned port. Channel-visible
  behavior can use boundary harness proof for development; runtime release still
  requires the real Telegram canary (`$telegram-e2e-userbot` on the server).
- Do not bypass failing gates. Fix task-related failures; identify unrelated
  current-main failures with scoped evidence and report remaining blockers.
  Report exactly which proof is missing when the environment cannot provide it.

## Code

Read [.agents/guidance/code.md](.agents/guidance/code.md) for implementation and
code review. It retains TypeScript, lint, naming, and module-boundary conventions.

## Tests

Read [.agents/guidance/tests.md](.agents/guidance/tests.md) when writing tests or
setting up proof. Use disposable state and isolated gateways; never weaken checks
or alter operator state to manufacture a passing result.

## ClawSweeper Review Policy

Use [.agents/guidance/clawsweeper-review.md](.agents/guidance/clawsweeper-review.md)
for ClawSweeper reviews and its review findings, not as a preflight for all tasks.

## GitHub / PRs

Use [.agents/guidance/github.md](.agents/guidance/github.md) when creating or
managing issues, PRs, reviews, or landing. Arxi's server-receipt landing contract
above takes precedence over upstream CI and `scripts/pr` procedures.
`CODEOWNERS` routes reviewers; it does not itself establish enforced approval.
Preserve restricted/security ownership and verify actual protection rules when
relevant. For upstream ownership/review governance changes, follow the organization
owner authorization requirements in `CONTRIBUTING.md`; Arxi fork policy changes
follow the Arxi owner's explicit direction. Neither waives GitHub-enforced review.

## Tooling Gotchas

Consult [.agents/guidance/tooling.md](.agents/guidance/tooling.md) for a relevant
shell/Git/GitHub problem; it is not required reading before ordinary commands.

## Docs / Changelog

- Use `$technical-documentation` for substantial documentation/instruction work;
  a small wording correction needs only relevant context and checks.
- Product-facing docs track changed behavior/API. When upgrading the Codex harness,
  refresh the model snapshot in `docs/plugins/codex-harness.md` from its model list.
- `CHANGELOG.md` is release-generated. Put release-note context for normal
  fixes/features/performance work in the PR body or commit instead.

## Git

- Commit with standard Git commands; stage intended files only.
- Commits: conventional-ish, concise, grouped.
- No manual stash/autostash unless explicit. Branch switches and task-owned worktrees are allowed when useful; preserve user-managed checkouts and unrelated work.
- `main`: no merge commits; rebase on latest `origin/main` before push. After one green run plus clean rebase sanity, do not chase moving `main` with repeated full gates.
- User says `commit`: your changes only; `commit all`: all changes in grouped chunks; `push`: may `git pull --rebase` first; `ship it`: commit intended changes, pull --rebase, push.
- Do not delete/rename unexpected files; ask if blocking, else ignore.
- Bulk PR close/reopen >50: ask with count/scope.

## Security / Release

- Never publish internal or unreleased model identifiers in code, fixtures, commits, PRs, issues, comments, logs, transcripts, or screenshots/video. Use synthetic identifiers in fixtures; tests requiring real models must use stable public IDs. Elsewhere, use stable public model IDs—or “Codex”. Sanitize copied commands and check diffs and proof artifacts before publishing.
- Never commit real phone numbers, videos, credentials, live config.
- Secrets: channel/provider creds in `~/.openclaw/credentials/`; shared model auth profiles in `~/.openclaw/state/openclaw.sqlite`, with agent-local profiles overriding the shared read-through base; see `docs/auth-credential-semantics.md`.
- SecretRef failures isolate to the smallest known owning surface; unknown ownership fails closed. Gateway starts degraded (exact owner marked configured-unavailable, typed redacted diagnostic, no implicit credential fallback) rather than refusing startup, except for its own ingress protection or structurally invalid config. Doctor and status list every degraded owner. Full doctrine: `docs/gateway/secrets.md`.
- Dependency patches/overrides/vendor changes need explicit approval. `pnpm-workspace.yaml` patched dependencies use exact versions only.
- Release/package guards: no hard-coded retired-package denylists; use generic artifact/dependency checks or fix build source.
- `pnpm-lock.yaml` is the product dependency security review surface; `.github/release/clawhub-cli/package-lock.json` separately pins trusted release tooling. Published packages bundle runtime dependencies where configured and never ship lockfiles; other npm-format locks exist only transiently during checks and publish staging.
- Releases/publish/version bumps need explicit approval. `$release-openclaw-maintainer` owns the full flow: two-SHA (Code/Release) identities, `YYYY.M.PATCH` versioning and train selection, backports, scope lock, changelog generation, publish, and verification. Nightlies: `$release-openclaw-nightly`; release CI: `$release-openclaw-ci`.
- During an active release, freeze the operator-selected cut SHA and release identity through publish and verification; touch `main` only for the smallest critical main-owned blocker or on operator request, then return to the release branch.
- GHSA/advisories: never create, open, draft, update, publish, or otherwise mutate a GitHub Security Advisory, GHSA temporary fork, private security-review repository, or security-only review artifact unless the user explicitly asks for that exact advisory/security workflow action. Terms such as "security-sensitive", "hardening", "private review", "unshipped", or "unreleased" grant no advisory authority; unshipped hardening uses the normal code/PR workflow. Routes: `$openclaw-ghsa-maintainer` / `$security-triage`. Secret scanning: `$openclaw-secret-scanning-maintainer`.

## Platform / Ops

Use [.agents/guidance/platform-ops.md](.agents/guidance/platform-ops.md) for native
app and gateway operations. Preserve isolation, signing, and channel-delivery
contracts. Never edit `node_modules` or expose live credentials/state in source.
