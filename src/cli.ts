#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultDeps, resolveBinary } from './resolve.js';
import { runBinary } from './run.js';

const USAGE = `tmgr-notify: phone push notifications and urgent alarms for AI agents (runs the tmgr CLI)

Usage:
  tmgr-notify [mcp]                              MCP server on stdio (tmgr mcp)
  tmgr-notify send --title T [--body B] [--priority P] [--link L]
  tmgr-notify alarm ...                          same flags as tmgr alarm
  tmgr-notify hook notification|prompt|stop      Claude Code hooks
  tmgr-notify hook codex ...                     Codex hook
  tmgr-notify --help | --version

Environment:
  TMGR_BIN             path to a tmgr binary (skips PATH and bundled lookup)
  TMGR_NOTIFY_TOKEN    notify token
  TMGR_URL             API base URL
`;

const CLAUDE_HOOKS: Record<string, string> = {
  notification: 'notification',
  prompt: 'user-prompt-submit',
  stop: 'stop',
};

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[arg.slice(2)] = next;
      i++;
    } else {
      out[arg.slice(2)] = '';
    }
  }
  return out;
}

function sendArgs(flags: Record<string, string>): string[] {
  const out = ['notify', '--title', flags.title];
  if (flags.priority) out.push('--priority', flags.priority);
  if (flags.link) out.push('--link', flags.link);
  out.push(flags.body || flags.title);
  return out;
}

function warnLegacyEnvFile(): void {
  if (process.env.TMGR_NOTIFY_TOKEN) return;
  try {
    const file = join(homedir(), '.config', 'tmgr-notify', 'env');
    if ((statSync(file).mode & 0o077) !== 0) {
      process.stderr.write(
        'tmgr-notify: the tmgr CLI ignores ~/.config/tmgr-notify/env unless it is private; run: chmod 600 ~/.config/tmgr-notify/env\n',
      );
    }
  } catch {
    return;
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

async function launch(args: string[], hook: boolean): Promise<number> {
  let path: string;
  try {
    path = (await resolveBinary(defaultDeps())).path;
  } catch (err) {
    process.stderr.write(`tmgr-notify: ${err instanceof Error ? err.message : String(err)}\n`);
    return hook ? 0 : 1;
  }
  warnLegacyEnvFile();
  const code = await runBinary(path, args, hook);
  return hook ? 0 : code;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;

  if (!cmd || cmd === 'mcp') return launch(['mcp', ...argv.slice(1)], false);

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd === '--version' || cmd === '-V') {
    process.stdout.write(`tmgr-notify ${packageVersion()}\n`);
    return 0;
  }

  if (cmd === 'send') {
    const flags = parseFlags(argv.slice(1));
    if (!flags.title) {
      process.stderr.write('tmgr-notify send: --title is required\n');
      return 1;
    }
    return launch(sendArgs(flags), false);
  }

  if (cmd === 'alarm') return launch(['alarm', ...argv.slice(1)], false);

  if (cmd === 'hook') {
    if (sub === 'codex') return launch(['hook', 'codex', ...rest], true);
    if (sub && Object.hasOwn(CLAUDE_HOOKS, sub)) return launch(['hook', 'claude', CLAUDE_HOOKS[sub]], true);
    process.stderr.write(`tmgr-notify: unknown hook "${sub}"\n`);
    return 0;
  }

  process.stderr.write(`tmgr-notify: unknown command "${cmd}"\n`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`tmgr-notify: fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
