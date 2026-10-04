# @tmgr/notify

MCP server and Claude Code / Codex hook CLI that lets an AI agent reach you on your phone.

[TMGR](https://tmgr.dev) is a task manager with an iOS app. With `@tmgr/notify` (command `tmgr-notify`) an agent (Claude Code, Codex, or any MCP client) gets three tools:

- `notify_user` sends a push notification.
- `alarm` rings you for an urgent incident: an alarm in the app, then a voice call if you do not acknowledge it.
- `alarm_status` re-checks an alarm.

The package also ships hooks that notify you automatically when Claude Code needs input or finishes a long turn, and when a Codex turn completes.

## Requirements

- Node 22 or newer
- A TMGR account
- The TMGR mobile app, for push notifications and for alarms (AlarmKit)

## Get a token

In TMGR open **Settings → Agent notifications → Create token**. The token (`tmgrn_...`) is shown once, so copy it right away. You can revoke it from the same screen.

## Configuration

Configuration is read from environment variables first, then from a fallback file. Environment variables always win.

| Variable | Required | Description |
| --- | --- | --- |
| `TMGR_URL` | no | API base URL, default `https://api.tmgr.dev`. Override it for a self-hosted or local TMGR. A base that already ends in `/api` is normalized. |
| `TMGR_NOTIFY_TOKEN` | yes | The `tmgrn_...` token. Sent as `Authorization: Bearer <token>`. |
| `TMGR_NOTIFY_STOP_MIN_MINUTES` | no | Minimum turn duration in minutes before `hook stop` sends a "finished" push. Default `5`. |

If a variable is not set, `tmgr-notify` reads it from `~/.config/tmgr-notify/env`, one `KEY=VALUE` per line, `#` comments allowed:

```
TMGR_NOTIFY_TOKEN=<TMGR_NOTIFY_TOKEN>
```

The file holds a bearer token, so restrict it: `chmod 600 ~/.config/tmgr-notify/env`.

## Claude Code

### MCP server

Register it once at user scope so it is available in every project:

```bash
claude mcp add -s user tmgr-notify \
  -e TMGR_NOTIFY_TOKEN=<TMGR_NOTIFY_TOKEN> \
  -- npx -y @tmgr/notify mcp
```

To keep the token out of `~/.claude.json`, skip the `-e` flag and rely on the env file above:

```bash
claude mcp add -s user tmgr-notify -- npx -y @tmgr/notify mcp
```

Or add it to a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "tmgr-notify": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@tmgr/notify", "mcp"]
    }
  }
}
```

MCP servers belong in `.mcp.json` or `~/.claude.json`, not in `settings.json`. Use `claude mcp list` to check the connection.

### Hooks

Hooks live in `~/.claude/settings.json` (user scope shown, project scope works the same way). Add all three:

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          { "type": "command", "command": "npx -y @tmgr/notify hook notification" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "npx -y @tmgr/notify hook prompt" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "npx -y @tmgr/notify hook stop" }
        ]
      }
    ]
  }
}
```

`npx` adds startup latency to every hook run. For faster hooks install the package globally with `npm i -g @tmgr/notify` and use `tmgr-notify hook ...` as the command.

`UserPromptSubmit` and `Stop` do not support a `matcher`. They fire on every prompt and turn, which is what the `hook prompt` / `hook stop` pair needs to measure turn duration.

What each hook does:

- `Notification` (needs your input, permission, or idle prompt): sends a high-priority push titled `Claude Code · <project> · needs you`, with the first line of the message as the body. This event fires for more than permission prompts, so the wording is generic ("needs your attention"). The types `auth_success`, `elicitation_complete` and `elicitation_response` are skipped.
- `UserPromptSubmit`: records the turn start time in a per-session state file under `~/.cache/tmgr-notify/` (falls back to the OS temp directory). No network call.
- `Stop`: does nothing if `stop_hook_active` is true. Otherwise it reads the recorded turn start; if that is missing it falls back to the last user prompt timestamp in the transcript (best effort). If the turn lasted at least `TMGR_NOTIFY_STOP_MIN_MINUTES` (default 5) it sends a normal-priority push titled `Claude Code · <project> · done`, with the first line of the last assistant message as the body.

`<project>` is the basename of the working directory.

Every hook subcommand always exits `0` and writes nothing to stdout, so a misconfigured or failing hook never changes the behaviour of Claude Code or Codex. Diagnostics go to stderr only, and the token is never logged.

## Codex

Codex's `notify` hook is user-level only (`~/.codex/config.toml`); a project's `.codex/config.toml` cannot set it. Codex runs the program with the event JSON as the final argv argument (not stdin), for the `agent-turn-complete` event:

```toml
notify = ["npx", "-y", "@tmgr/notify", "hook", "codex"]
```

To also let Codex call the tools directly:

```toml
[mcp_servers.tmgr-notify]
command = "npx"
args = ["-y", "@tmgr/notify", "mcp"]
tool_timeout_sec = 660

[mcp_servers.tmgr-notify.env]
TMGR_NOTIFY_TOKEN = "<TMGR_NOTIFY_TOKEN>"
```

Codex cancels MCP tool calls after 60 s by default, while `alarm` waits up to 600 s; `tool_timeout_sec = 660` keeps the result. Omit the `env` table to rely on `~/.config/tmgr-notify/env` instead of putting the token in `config.toml`.

`hook codex` sends a normal-priority push titled `Codex · <project>` with the first line of `last-assistant-message` as the body, only when `type` is `agent-turn-complete`.

## Alarm setup

`notify_user` is a soft channel. `alarm` is for incidents that need you now (production down, data loss, security). A silent push triggers an alarm in the mobile app. If you do not acknowledge it in time, or the app never receives it, TMGR places a voice call where pressing `1` acknowledges. One `alarm` call is one escalation; the calling agent decides whether to retry. Prefer `notify_user` for everything else.

To make alarms reliable:

1. In TMGR Settings, set and verify an alarm phone. Without it the voice-call fallback is unavailable and the alarm is push-only; it ends as `call_unavailable` if the app does not acknowledge it.
2. Add the TMGR caller number to your contacts or Favorites so Focus / Do Not Disturb lets the call through.
3. On iOS enable Repeated Calls (Settings → Focus → Do Not Disturb → Allow Calls From) so a second call within 3 minutes gets through.
4. Install the mobile app and allow alarms (AlarmKit) when prompted.

The voice call repeats until acknowledged: up to `callAttempts` calls (default 3, the server clamps it to 1-5). Each attempt rings for about 55 s, with about 20 s between attempts. Answering machines are detected and hung up, so voicemail never counts as an acknowledgement.

## Tools reference

### `notify_user`

| Parameter | Type | Description |
| --- | --- | --- |
| `title` | string, required | 1-120 characters. |
| `body` | string | Up to 1000 characters. |
| `priority` | `low` \| `normal` \| `high` | Default `normal`. |
| `link` | string | Absolute http(s) URL to open on tap. |

Returns the status on success. A rate limit is returned as a tool error with the retry-after seconds.

### `alarm`

| Parameter | Type | Description |
| --- | --- | --- |
| `title` | string, required | 1-120 characters, read aloud on the call. |
| `message` | string, required | 1-500 characters, read aloud on the call. |
| `ackTimeoutSeconds` | integer | Seconds to wait for an app acknowledgement before calling. The server clamps it to 15-900. |
| `deliveryTimeoutSeconds` | integer | Seconds to wait for the app to receive the alarm before calling. The server clamps it to 10-300. |
| `call` | boolean | Voice-call fallback, default `true`. With `false` the alarm ends `expired` if not acknowledged in the app. |
| `callAttempts` | integer 1-5 | Voice-call attempts, default 3. The result includes `attempts: made/max`. |
| `waitForResult` | boolean | Default `true`. With `false` it returns `{id, status}` immediately. |
| `maxWaitSeconds` | number, max 3600 | Wait cap, default 600. On timeout the last status is returned with `timedOut: true`. |

With `waitForResult` it long-polls until a final status or `maxWaitSeconds`, and returns the status, ack channel, call status and alarm id. While waiting, transient network errors, 5xx and 429 responses are retried up to 3 times (1 s, 2 s, 4 s backoff; `Retry-After` honored, capped at 10 s); 401 and 404 fail at once. If a call times out client-side the alarm keeps running on the server; re-check it with `alarm_status`.

### `alarm_status`

| Parameter | Type | Description |
| --- | --- | --- |
| `id` | string, required | Alarm id returned by `alarm`. |
| `waitSeconds` | integer 0-50 | Long-poll seconds, default 0. |

Use it after a timeout or after `waitForResult: false`.

### Alarm statuses

Non-final: `pending`, `delivered`, `calling`. Final: `acknowledged` (channel `app` or `call`), `no_answer`, `busy`, `failed`, `call_unavailable`, `expired`.

### Client tool-call timeouts

A blocking wait can be long, so the client's MCP tool-call timeout matters.

- Claude Code CLI: `MCP_TOOL_TIMEOUT` defaults to about 28 hours, so the 600 s default wait fits. A per-server `timeout` in `.mcp.json` overrides it as a hard limit that progress notifications do not extend. A stdio call that sends no response and no progress for 30 minutes is aborted.
- Claude desktop app and Cowork: reported to cancel tool calls at about 60 s regardless of `MCP_TOOL_TIMEOUT`.
- While waiting, the server sends `notifications/progress` after every poll when the client supplies a `progressToken`. For clients with a short hard cap, pass a small `maxWaitSeconds` (for example 45) or `waitForResult: false`, then call `alarm_status`.

A full default escalation (3 attempts) takes about 6 minutes; 5 attempts take about 9 minutes, so with long timeouts pass a larger `maxWaitSeconds`.

## CLI

```bash
npx -y @tmgr/notify send --title "Deploy finished" --body "v1.2.3 is live" --priority high [--link https://example.com]
```

Exits non-zero and prints an `error: ...` line on failure (auth, validation, rate limit, timeout, network).

```bash
npx -y @tmgr/notify alarm "prod DB is down" --title "Prod down" [--no-wait] [--ack-timeout 90] [--delivery-timeout 30] [--no-call] [--call-attempts 3]
```

The default title is `Alarm`. `--no-call` disables the voice-call fallback. It prints each status change and the final status. The exit code is `0` only when the alarm was acknowledged (with `--no-wait`, `0` once the alarm is created).

```bash
npx -y @tmgr/notify mcp                       # MCP server over stdio (also the default with no arguments)
npx -y @tmgr/notify hook notification|prompt|stop   # Claude Code hooks, payload on stdin
npx -y @tmgr/notify hook codex '<event json>'       # Codex notify, payload as last argument
```

To test the backend independently of this CLI:

```bash
curl -i -X POST https://api.tmgr.dev/api/notifications/push \
  -H "Authorization: Bearer <TMGR_NOTIFY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","body":"Hello from curl","priority":"normal"}'
```

## Security

- The token is a bearer secret. Keep it out of repositories, prefer the `~/.config/tmgr-notify/env` file (mode 600), and revoke it in TMGR if it leaks.
- Agents cannot acknowledge alarms. Only you can, in the app or by pressing `1` on the call.
- Hooks and tools never print the token.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Troubleshooting

- No push arrives and no error is shown: hooks swallow all errors to stderr and always exit `0` by design. Check that your env vars or `~/.config/tmgr-notify/env` are visible to the shell that Claude Code or Codex spawns (a login shell profile may not be sourced). Run the matching `hook` subcommand by hand with sample stdin or argv to see stderr.
- `hook stop` never fires: short turns stay silent below `TMGR_NOTIFY_STOP_MIN_MINUTES` (default 5). Also confirm the `UserPromptSubmit` hook is configured; without it `hook stop` only has the transcript fallback, which can be inaccurate.
- 401 from the API: the token was revoked, or another auth header was sent alongside it (the API allows exactly one auth method).
- 429 from the API: rate limited per user, 20 per minute by default; retry after the `Retry-After` value.
- MCP tool not showing up in Claude Code: check `claude mcp list`, and remember `mcpServers` does not go in `settings.json`.
- Codex notify does nothing: `notify` is ignored in a project-local `.codex/config.toml`; set it in `~/.codex/config.toml`. Codex passes the JSON as an argv string, not on stdin.

## Development

```bash
npm ci
npm test
```

`npm test` compiles `src/` and `test/` to `dist/` and runs the `node:test` suite. No network calls are made; the HTTP client tests use a local server.

## License

MIT
