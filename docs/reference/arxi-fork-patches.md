---
summary: "Disposition ledger for Arxi patches rebased onto the selected OpenClaw upstream"
read_when:
  - Updating the OpenClaw version used by Arxi
  - Removing or adding an Arxi fork patch
  - Qualifying the Arxi owner-channel runtime
title: "Arxi fork patch ledger"
---

# Arxi fork patch ledger

## Selected upstream

Arxi is pinned to exact upstream commit
`b576bb41cf4b3b3418a25e925d9b48ff6dd18c57` from 2026-08-28. No released
OpenClaw version contained the Automations-owned heartbeat monitor at selection
time. The Operator selected this unreleased commit in
`pochinkovtrofim/arxi-platform#136` after recording the benefit, risk, and
continuing cost of a narrow backport.

The selected commit is the merge result of upstream PR
[`openclaw/openclaw#131667`](https://github.com/openclaw/openclaw/pull/131667).
Its head `878b2f0a036ed1579f5c0989977e818523ea5706` passed the complete upstream
`openclaw/ci-gate` in Actions run
[`33159536134`](https://github.com/openclaw/openclaw/actions/runs/33159536134).
On the selected main SHA, Workflow Sanity run
[`33161669413`](https://github.com/openclaw/openclaw/actions/runs/33161669413)
and CodeQL run
[`33161669440`](https://github.com/openclaw/openclaw/actions/runs/33161669440)
passed. Its main-push CI run was cancelled by upstream concurrency after a newer
main commit appeared, so Arxi qualification relies on the successful PR gate
plus the focused shipped-surface checks documented in `.github/ARXI_CI.md`.

## Dispositions

`Retain` means the rebased branch still contains a narrow Arxi contract.
`Redesign` means the required outcome remains but was adapted to the selected
upstream interface. `Remove` means no Arxi implementation remains. Merge-only
commits are structural provenance and are not replayed by the rebase.

| Original commit | Contract                                    | Disposition at `b576bb41cf4`                                                                                                    | Removal condition                                                                                                                       |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `3e5bf4e0dc0`   | Large tracked-file enumeration              | Remove: upstream `listRepoFilesSync` is bounded and handles the repository                                                      | Already upstream-owned                                                                                                                  |
| `5fa6e33b1f4`   | Runtime auth-store relocation               | Retain as `cd10bf7a31d`; exact `ARXI_AUTH_AGENT_DIR` seam                                                                       | Upstream gains an equivalent explicit credential-store boundary                                                                         |
| `8f400ab71da`   | Atomic suspend wake response                | Redesign as `ab591aeb23c` for upstream drain leases; inspect wake only after admitted work settles                              | Upstream suspension protocol returns a complete, atomic next-wake snapshot with the same fail-closed lifecycle semantics                |
| `146ac143199`   | Generated Control UI locale handoff         | Remove: current upstream owns the generated catalog and locale transition                                                       | Already upstream-owned                                                                                                                  |
| `1563f5fc869`   | Pinned sync generated-mix repair            | Retain as `efc9de5aed2` for historical same-repository merge-sync compatibility                                                 | Fork no longer needs upstream generated-artifact CI compatibility                                                                       |
| `8a66c1968bb`   | Fetch pinned sync ancestry                  | Retain as `01325f79869` with the bounded same-repository fetch                                                                  | The generated-mix compatibility above is removed                                                                                        |
| `d6aa6f5888a`   | Generated native suspend models             | Retain as `bceb035c365`; generated consumer matches the public suspend schema                                                   | Upstream ships the Arxi suspend fields in its generated native protocol                                                                 |
| `af1c35d1732`   | Suspension lifecycle coverage               | Retain as `e8dd4cac93a`                                                                                                         | Upstream exposes a stable suspension conformance suite covering Arxi's host contract                                                    |
| `de05c78cdf7`   | Shallow-safe lifecycle pin guard            | Retain as `002cd5f80d6` and repin for each reviewed upstream                                                                    | Arxi stops consuming source-level lifecycle inventory                                                                                   |
| `88c1e6af567`   | Hosted routing for noncanonical forks       | Remove: current upstream runner-profile resolution covers this repository                                                       | Already upstream-owned                                                                                                                  |
| `a344aa779e7`   | Native suspend wake policy generation       | Retain as `eeea7a2ff58`                                                                                                         | Upstream generated protocol contains equivalent complete/incomplete wake policy types                                                   |
| `3fd3b7631e3`   | Credential-only auth seam                   | Retain as `39c99746e9e`; auth DB is outside owner-state migration roots                                                         | Upstream supports separate encrypted runtime credential custody without an Arxi path override                                           |
| `a763860ae4f`   | Privileged proof cache write fence          | Retain as `fc92d84f3c1`                                                                                                         | Proof workflow no longer runs with privileged cache credentials                                                                         |
| `9e30c946caf`   | Candidate proof cache restore-only behavior | Retain as `39c9edce631`; no candidate cache save                                                                                | Same as above                                                                                                                           |
| `642cc50823d`   | Exclude credential DB from state migrations | Retain as `b6e33cf990b`                                                                                                         | Upstream migrations distinguish credentials from owner state by contract                                                                |
| `184535669f0`   | Structured device-login events              | Retain as `67361221b95`                                                                                                         | Upstream exposes the authenticated structured login lifecycle Arxi consumes                                                             |
| `62377b57690`   | Durable final source-run correlation        | Redesign as `34edc2440c9` for current outbound preparation and recovery                                                         | Upstream channel delivery preserves exact useful-final run provenance end to end                                                        |
| `d2912198c46`   | Codex terminal run ownership                | Remove: current upstream owns terminal assistant/run identity and mirror ownership                                              | Already upstream-owned                                                                                                                  |
| `2b5daaf7c13`   | Agent RPC media input                       | Retain as `cdd2fc81a52`                                                                                                         | Upstream agent RPC accepts the bounded media contract Arxi ships                                                                        |
| `87bbfd23e8b`   | Agent audio transcription                   | Retain as `d7730752d42`                                                                                                         | Upstream provides equivalent authenticated agent-audio understanding                                                                    |
| `e643bcf37f2`   | Startup session-store rescan avoidance      | Remove: current upstream lifecycle cache owns startup reuse                                                                     | Already upstream-owned                                                                                                                  |
| `98342f4d303`   | Exact loopback Exa provider seam            | Retain as `ad1d1943b82`; only `http://127.0.0.1:18080/search`, without proxy trust                                              | Upstream provides a pinned provider transport with the same exact local boundary                                                        |
| `3d9c7a5b973`   | Telegram conversation runtime contract      | Retain as `449745281cc`; adapted to current Telegram internals                                                                  | Upstream publishes the required bounded Telegram adapter interface                                                                      |
| `88402039c07`   | Telegram delivery planning                  | Redesign as `4ce6ebf8d49` and the later transport-plan corrections                                                              | Same as above                                                                                                                           |
| `539bc01cef6`   | Durable Telegram planning context           | Redesign as `e0b4c2aeb5a`; preserve original filenames and external context across spool/recovery                               | Upstream durable Telegram replay retains equivalent immutable planning facts                                                            |
| `02521142c0a`   | Generated SDK export ordering               | Retain as `d04c07ce838`                                                                                                         | Upstream generator guarantees the package export ordering consumed by the fork                                                          |
| `b1fe05a4af6`   | Canonical Telegram external context         | Retain as `086050ebb9b`                                                                                                         | Upstream exposes one canonical bounded Telegram context projector                                                                       |
| `9d1478e7d6f`   | Runtime-plan media filename                 | Retain as `56a5aafad7e`                                                                                                         | Upstream runtime-plan contract preserves original media filenames                                                                       |
| `d839a62057e`   | Telegram transport CI corrections           | Retain as `f1993468b1c`                                                                                                         | Telegram planning is upstream-owned and no fork transport export remains                                                                |
| `9493155c4d8`   | Arxi shipped-surface fork gate              | Retain as `1d8f4e530f9`                                                                                                         | Another gate proves the exact Linux runtime and every fork seam Arxi ships                                                              |
| `1feb86782dc`   | Active-model readiness projection           | Partial remove: upstream owns the implementation and test; retain only Arxi CI selection in `8ba62f94500`                       | Arxi fork gate no longer needs to name this shipped dependency                                                                          |
| `46e5363f621`   | Catalog-worker plugin metadata              | Partial remove: upstream owns the stronger cache-bound restore; retain only Arxi CI selection in `7a442aaf2c0`                  | Arxi fork gate no longer needs to name this shipped dependency                                                                          |
| `669b72e8447`   | Codex vision in live catalogs               | Retain as `308f6904865`                                                                                                         | Upstream catalog preserves the same account-scoped vision capability                                                                    |
| `ee306f4f9ce`   | Projected model-route normalization         | Retain as `27e0904ed7b`                                                                                                         | Upstream listing resolves the same canonical effective routes                                                                           |
| `482145f3e72`   | Model media run correlation                 | Retain as `b794891d32d`                                                                                                         | Upstream durable model-media delivery preserves useful-final run provenance                                                             |
| `67e46ca35e3`   | Exact Telegram formatting on replay         | Retain as `f372191c9b0`                                                                                                         | Upstream durable replay preserves the selected Telegram transport plan exactly                                                          |
| `39aad6b7b18`   | Current plugin-tool execution context       | Redesign as `09d6ad56572` for current hook and Automation-run cancellation contracts                                            | Upstream cached plugin descriptors reconstruct tools with the admitted run's authenticated execution context                            |
| New in `#136`   | Model-authored text result correlation      | Retain: classify an explicit model `message` send as a useful final result so its admitted run reaches durable channel delivery | Upstream carries the exact admitted run through model-authored text delivery without classifying operator or CLI sends as agent results |

The structural commits `cd299e6726b`, `2ff09ce1db7`, `f2ee8549363`,
`f917a1355e8`, `29fc382ebe0`, `f77bb146261`, `eb22565f011`,
`37ee132897e`, `030a5fdec22`, and `434be9f4f36` are merge provenance only.
They were intentionally not replayed by the rebase.

## Proactivity ownership after the rebase

OpenClaw owns the composition
`Standing Order → Automation → Task Flow Initiative → Background Task → verified Achievement → response`.
The heartbeat name remains only where upstream uses it for the system-owned
Automation monitor execution path. Arxi owns no timer, candidate selector,
prompt engine, portfolio, or proactive memory layer. Its fork seams are limited
to runtime custody, exact wake reporting, authenticated execution context, and
durable response correlation required by the host composition.
