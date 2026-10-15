# Changelog

## 1.0.0 — 2026-10-15

`@tmgr/notify` is now a thin launcher for the `tmgr` CLI 1.0.1 (`tmgr-dev/frontend`, `crates/tmgr-cli`), which implements the MCP server, the hooks and the commands.

Kept from 0.2.0:

- Package name `@tmgr/notify`, command `tmgr-notify`, and `npx -y @tmgr/notify mcp`.
- MCP tools `notify_user`, `alarm`, `alarm_status` with the same parameters. A fourth tool, `tmgr_cli`, returns short CLI help.
- Hooks `hook notification`, `hook prompt`, `hook stop`, `hook codex`. They still always exit `0` and print nothing to stdout.
- Commands `send` and `alarm`.
- `TMGR_NOTIFY_TOKEN`, `TMGR_URL`, `TMGR_NOTIFY_STOP_MIN_MINUTES` and `~/.config/tmgr-notify/env`.

New:

- The `tmgr` binary is found through `TMGR_BIN`, then `tmgr` 1.x (1.0.1 or newer) on `PATH`, then the platform package `@tmgr/notify-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}`.
- Platform binaries are checked against SHA-256 hashes pinned in `cli-release.json` when the platform packages are built and again before every start. A mismatch stops `tmgr-notify` with an error; the binary is never run.
- No install script and no download at run time: `--ignore-scripts`, pnpm and `npx -y` work.
- `--help` and `--version`.
- No runtime npm dependencies.

Migration notes:

- `~/.config/tmgr-notify/env` must be mode 600 (`chmod 600 ~/.config/tmgr-notify/env`). The CLI ignores a file that other users can read; `tmgr-notify` prints a hint on stderr in that case.
- Windows is not supported natively. Use WSL2, or stay on 0.2.0.
- Installs with `--omit=optional` have no binary. Install the `tmgr` CLI or set `TMGR_BIN`.
- `send` without `--body` uses the title as the text. Its output and error lines now come from `tmgr notify`.
- The MCP server reports itself as `tmgr` in `serverInfo`.
- Hooks also update agent work runs started with `tmgr agent start` when you are signed in to the CLI.
- License: this package stays MIT; the binaries in the platform packages are AGPL-3.0-only.


## 0.2.0 — 2026-10-04

First public release. Version 0.1.0 was internal-only and never published.

- MCP tools over stdio: `notify_user`, `alarm`, `alarm_status`.
- Claude Code hooks: `hook notification`, `hook prompt`, `hook stop`.
- Codex notify hook: `hook codex`.
- CLI: `send` for a manual push, `alarm` for an urgent alarm.
- `TMGR_URL` is optional and defaults to `https://api.tmgr.dev`; only `TMGR_NOTIFY_TOKEN` is required.
