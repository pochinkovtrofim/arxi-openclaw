# Platform / Ops

Read when working on native apps, gateway operations, or external channel delivery. Paths and commands in this document are repository-root
relative unless explicitly stated otherwise. The root AGENTS.md Arxi execution
and authorization rules apply to every example and linked skill.

- For device-dependent behavior, use a suitable available device or emulator.
  Native macOS/iOS signing, build, and test proof requires macOS/Xcode; if the
  authorized Arxi execution environment cannot provide it, report the missing
  proof and obtain explicit authorization before using another host. Linux
  checks do not establish native-platform acceptance.
- "restart iOS/Android apps" = rebuild/reinstall/relaunch, not kill/launch.
- Mac gateway: dev watch = `pnpm gateway:watch`; managed installs = `openclaw gateway restart/status --deep`; logs = `./scripts/clawlog.sh`. No launchd/ad-hoc tmux.
- Mac app permission testing: stable app path + real signing identity, or TCC prompts/listing won't stick; doctrine: `docs/platforms/mac/signing.md`.
- Parallels: `$openclaw-parallels-smoke`; Discord roundtrip: `$parallels-discord-roundtrip`.
- ClawSweeper ops: `$clawsweeper`. Deployed ClawSweeper hook sessions may post one concise `#clawsweeper` note only when surprising/actionable/risky; if using message tool, reply exactly `NO_REPLY`.
- Never edit `node_modules`.
- Local-only `.agents` ignores: `.git/info/exclude`, not repo `.gitignore`.
- External messaging: follow `docs/concepts/streaming.md` (no token-delta channel messages).
