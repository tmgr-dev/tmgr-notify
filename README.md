# tmgr-notify

Standalone MCP server + Claude Code / Codex hook CLI that sends phone push
notifications through TMGR's agent notifications endpoint
(`POST /api/notifications/push`, see TM-364).

It gives an AI coding agent (Claude Code, Codex, or any MCP client) a way to
reach you on your phone: a `notify_user` MCP tool the agent can call directly,
plus hook integrations that fire automatically when Claude Code needs input
or finishes a long turn.

## What's in this package

- `notify_user` MCP tool, served over stdio (`tmgr-notify` / `tmgr-notify mcp`)
- `tmgr-notify send` — manual one-off push from a shell, for testing
- `tmgr-notify hook notification` — Claude Code `Notification` hook (needs
  your input / permission / idle prompt)
- `tmgr-notify hook prompt` — Claude Code `UserPromptSubmit` hook (records
  when a turn started)
- `tmgr-notify hook stop` — Claude Code `Stop` hook (pushes "finished" only
  for turns longer than a threshold)
- `tmgr-notify hook codex` — Codex CLI `notify` program (pushes when an
  agent turn completes)

Every hook subcommand always exits `0` and writes nothing to stdout — a
misconfigured or failing hook must never change Claude Code's or Codex's
behavior. Diagnostics go to stderr only, and the notify token is never
logged.

## Build

Requires Node 22+ (the compiled output uses features that need a recent
Node; do not rely on TypeScript type-stripping).

```bash
cd tools/tmgr-notify
npm ci
npm run build
```

`npm run build` compiles `src/` and `test/` to `dist/` and marks
`dist/src/cli.js` executable.

## Run the tests

```bash
npm test
```

This builds the package and runs the built-in `node:test` runner against the
compiled output in `dist/test/`. No network calls are made — the HTTP client
tests spin up a local `node:http` server.

## Getting a notify token

In the TMGR web app: **Settings → Agent notifications → Create token**. The
token (`tmgrn_...`) is shown once — copy it immediately, it cannot be
retrieved again later. Revoke a token from the same screen if it leaks.

## Configuration

Config is read from environment variables first, falling back to a file if
a variable isn't set. Env always wins over the file.

| Variable | Required | Description |
| --- | --- | --- |
| `TMGR_URL` | yes | API base URL, e.g. `https://api.tmgr.dev`. A base that already ends in `/api` (or `/api/`) is handled — the client normalizes it before appending `/api/notifications/push`. |
| `TMGR_NOTIFY_TOKEN` | yes | The `tmgrn_...` token from step above. Sent as `Authorization: Bearer <token>`. |
| `TMGR_NOTIFY_STOP_MIN_MINUTES` | no | Minimum turn duration (minutes) before the `hook stop` command sends a "finished" push. Default `5`. |

### Fallback config file

If an env var above isn't set, `tmgr-notify` reads it from
`~/.config/tmgr-notify/env` (created by you), `KEY=VALUE` per line, `#`
comments allowed:

```
TMGR_URL=https://api.tmgr.dev
TMGR_NOTIFY_TOKEN=<TMGR_NOTIFY_TOKEN>
```

Keep this file private (`chmod 600 ~/.config/tmgr-notify/env`) — it holds a
bearer token.

## Claude Code integration

### MCP server (`notify_user` tool)

MCP servers are configured per-project in `.mcp.json` or at user scope via
`claude mcp add`, **not** in `settings.json` (that file is for hooks — see
below). Recommended: register it once at user scope so it's available in
every project, with the token coming from the config file above rather than
inline:

```bash
claude mcp add --transport stdio --scope user tmgr-notify \
  -- node ~/path/to/task-manager/tools/tmgr-notify/dist/src/cli.js mcp
```

Or, editing `~/.claude.json` / a project's `.mcp.json` directly:

```json
{
  "mcpServers": {
    "tmgr-notify": {
      "type": "stdio",
      "command": "node",
      "args": ["~/path/to/task-manager/tools/tmgr-notify/dist/src/cli.js", "mcp"]
    }
  }
}
```

Paths and command arrays here are spawned without a shell, so `~` is **not**
expanded — use an absolute path. If you'd rather not rely on the config file,
you can also set the token inline via an `env` block on the server entry, but
the config file keeps it out of `~/.claude.json`.

### Hooks (`~/.claude/settings.json`)

Hooks *do* live in `settings.json` (user scope shown; project scope works
the same way). Add all three:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt|agent_needs_input",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/path/to/task-manager/tools/tmgr-notify/dist/src/cli.js hook notification"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/path/to/task-manager/tools/tmgr-notify/dist/src/cli.js hook prompt"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/path/to/task-manager/tools/tmgr-notify/dist/src/cli.js hook stop"
          }
        ]
      }
    ]
  }
}
```

`UserPromptSubmit` and `Stop` don't support a `matcher` field — they fire on
every prompt/turn, which is what the `hook prompt` / `hook stop` pair needs
to measure turn duration.

Unlike the MCP server, hook `command` strings run through a shell, so `~`
does expand here — but an absolute path works everywhere and is what's
shown above for consistency with the MCP snippet.

What each hook does, from the actual Claude Code hook payloads (verified
against the current hooks reference):

- **`Notification`** (input: common fields + `message`, `title?`,
  `notification_type?`) — sends a high-priority push titled
  `Claude Code · <basename(cwd)> · needs you` with the first line of `message` as the
  body. `Notification` fires for more than permission prompts (also
  `idle_prompt` after ~60s of silence, elicitations, etc.), so the body
  wording is generic ("needs your attention") rather than
  permission-specific. Known "not actually needs input" types
  (`auth_success`, `elicitation_complete`, `elicitation_response`) are
  skipped.
- **`UserPromptSubmit`** (input: common fields + `prompt`) — records the
  wall-clock time in a per-`session_id` state file under
  `~/.cache/tmgr-notify/` (falls back to `os.tmpdir()` if that directory
  isn't writable). No network call, no notification.
- **`Stop`** (input: common fields + `stop_hook_active`,
  `last_assistant_message`, ...) — if `stop_hook_active` is true, does
  nothing (avoids notifying on a hook-forced continuation). Otherwise reads
  back the turn's start time recorded by the prompt hook; if that's
  missing, it falls back to the last real user-prompt timestamp in the
  `transcript_path` JSONL (best-effort — the transcript can lag behind the
  in-memory conversation). If the turn lasted at least
  `TMGR_NOTIFY_STOP_MIN_MINUTES` (default 5), sends a normal-priority push titled `Claude Code · <basename(cwd)> · done`
  with the first line of `last_assistant_message` as the body.

## Codex CLI integration

Codex's `notify` hook is user-level only (`~/.codex/config.toml`) — a
project's `.codex/config.toml` cannot set it. It runs your program with the
event JSON as the **final argv argument** (not stdin), for exactly one event
type, `agent-turn-complete`:

```toml
notify = ["node", "/path/to/task-manager/tools/tmgr-notify/dist/src/cli.js", "hook", "codex"]
```

To also let Codex call `notify_user` directly as an MCP tool:

```toml
[mcp_servers.tmgr-notify]
command = "node"
args = ["/path/to/task-manager/tools/tmgr-notify/dist/src/cli.js", "mcp"]

[mcp_servers.tmgr-notify.env]
TMGR_URL = "https://api.tmgr.dev"
TMGR_NOTIFY_TOKEN = "<TMGR_NOTIFY_TOKEN>"
```

(Or omit the `env` table and rely on `~/.config/tmgr-notify/env` instead of
putting the token in `config.toml`.)

`tmgr-notify hook codex` sends a normal-priority push titled
`Codex · <basename(cwd)>` with the first line of `last-assistant-message` as
the body, only when `type` is `agent-turn-complete`.

## Manual testing

```bash
node dist/src/cli.js send --title "Deploy finished" --body "prod-java-1.2.3 is live" --priority high
```

Exits non-zero and prints an `error: ...` line on failure (auth, validation,
rate limit, timeout, network).

Or with curl directly, to test the backend independent of this CLI:

```bash
curl -i -X POST https://api.tmgr.dev/api/notifications/push \
  -H "Authorization: Bearer <TMGR_NOTIFY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","body":"Hello from curl","priority":"normal"}'
```

## Troubleshooting

- **No push arrives, no error anywhere**: hooks swallow all errors to
  stderr and always exit 0 by design. Check `~/.config/tmgr-notify/env` /
  your env vars are actually set in the shell Claude Code or Codex spawns
  from (a login shell profile may not be sourced). Run the equivalent
  `hook` subcommand by hand with sample stdin/argv to see the stderr output
  directly.
- **`hook stop` never fires**: the threshold is
  `TMGR_NOTIFY_STOP_MIN_MINUTES` (default 5) — short turns are expected to
  stay silent. Also confirm the `UserPromptSubmit` hook is wired up; without
  it, `hook stop` only has the transcript fallback, which can be skipped or
  inaccurate.
- **401 from the API**: token revoked, or an `Authorization` header sent
  alongside `X-Smart-Device-Token` / `X-Persona-Token` (the API allows
  exactly one auth method).
- **429 from the API**: rate limited per user, 20/minute by default; retry
  after the `Retry-After` value from the response.
- **MCP tool not showing up in Claude Code**: `mcpServers` belongs in
  `.mcp.json` / `~/.claude.json`, not `settings.json` — check `claude mcp
  list` for connection status.
- **Codex notify silently does nothing**: `notify` is ignored in a
  project-local `.codex/config.toml`; it must be set in the user-level
  `~/.codex/config.toml`. Also remember Codex passes the JSON as an argv
  string, not on stdin.

## Not implemented

Claude Code plugin packaging was skipped: a plugin's `hooks/hooks.json` and
`mcpServers` would still need to invoke this same built `dist/src/cli.js`,
and plugins don't run `npm install` for you, so a plugin wrapper adds
packaging overhead without removing the manual `npm ci && npm run build`
step. The `.mcp.json` / `settings.json` snippets above are used directly
instead.
