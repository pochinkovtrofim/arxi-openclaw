# TUI Notes

- Run TUI test commands only on the Arxi production server. Use
  `node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts`
  when the fast fake-backend PTY lane is relevant.
- Add `OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1` for the slower `tui --local` smoke test,
  which mocks only the external model endpoint. Here `--local` names the TUI
  backend mode; it does not authorize running the command on the developer host.
- The `tui --local` smoke mocks only the external model endpoint. The
  fake-backend lane runs the real `runTui()` loop with a fake `TuiBackend`.
- Do not claim the fake-backend PTY harness proves Gateway transport, embedded backend runtime, providers, session persistence, or live streaming.
- Prefer stable visible text and fixture backend call assertions. Avoid raw ANSI snapshots.
- `pnpm tui:pty:test:watch` watches the fast fake-backend PTY test without
  mixing Vitest reporter output into the TUI screen. Use `--mode local` for the
  local-backend smoke or `--mode all` for both.
