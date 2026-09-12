# ACPX Extension Notes

This file applies to work under `extensions/acpx/`.

## Purpose

The ACPX extension is a thin OpenClaw wrapper around the published `acpx` package. Keep reusable ACP runtime logic in `openclaw/acpx`, not in this extension.

## Default Version Policy

- `extensions/acpx/package.json` should point at a published npm release by default.
- Do not leave the extension pinned to a temporary GitHub commit or local checkout once the ACPX release exists.
- Do not leave temporary pnpm build-script allowlist exceptions behind after switching back to a published ACPX package.

## Unreleased ACPX Development

Use this only when OpenClaw needs an unreleased ACPX change. Land the reusable
change in `openclaw/acpx`, pin this extension to the required commit, and add a
temporary `allowBuilds.acpx` entry only if pnpm requires it. Keep both lockfiles
aligned with the pin. After ACPX publishes, return to the released npm version,
refresh both lockfiles, and remove the temporary allowlist entry.

## Lockfile Notes

- `pnpm-lock.yaml` is the tracked workspace lockfile and must match the ACPX version referenced by `extensions/acpx/package.json`.
- `extensions/acpx/package-lock.json` is install metadata for the plugin package.
- If `extensions/acpx/package-lock.json` is gitignored in this repo state, a
  refreshed copy will not appear in `git status`.

## Validation

Run applicable steps only on the Arxi production server. For an ACPX integration
change, install the pinned extension dependency and run its focused test. Add a
full build when package wiring or runtime imports change; restart the isolated
validation gateway when runtime behavior changes; add a real ACP smoke when chat
behavior changes.

Relevant commands:

- `pnpm install --lockfile-only --filter ./extensions/acpx`
- `cd extensions/acpx && npm install --package-lock-only --ignore-scripts`
- `pnpm install --filter ./extensions/acpx`
- `pnpm test:extension acpx`
- `pnpm build`

## Direct ACPX Binary Policy

- Prefer the plugin-local ACPX binary under `extensions/acpx/node_modules/.bin/acpx`.
- Do not rely on a globally installed `acpx` binary for OpenClaw ACP validation.
- If the plugin-local ACPX binary is missing or on the wrong version, reinstall it from the version pinned in `extensions/acpx/package.json`.

## Boundary Rule

If a change feels like shared ACP runtime behavior instead of OpenClaw-specific glue, move it to `openclaw/acpx` and consume it from here instead of re-implementing it inside `extensions/acpx`.
