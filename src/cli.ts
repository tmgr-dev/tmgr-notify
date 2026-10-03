#!/usr/bin/env node
import { runAlarm } from './commands/alarm.js';
import { runHookCodex } from './commands/hook-codex.js';
import { runHookNotification } from './commands/hook-notification.js';
import { runHookPrompt } from './commands/hook-prompt.js';
import { runHookStop } from './commands/hook-stop.js';
import { runSend } from './commands/send.js';
import { runMcpServer } from './mcp-server.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runHook(sub: string | undefined, rest: string[]): Promise<void> {
  process.on('uncaughtException', (err) => {
    process.stderr.write(`tmgr-notify: hook uncaught error: ${errorMessage(err)}\n`);
    process.exit(0);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`tmgr-notify: hook unhandled rejection: ${errorMessage(err)}\n`);
    process.exit(0);
  });

  try {
    switch (sub) {
      case 'notification':
        await runHookNotification();
        break;
      case 'prompt':
        await runHookPrompt();
        break;
      case 'stop':
        await runHookStop();
        break;
      case 'codex':
        await runHookCodex(rest);
        break;
      default:
        process.stderr.write(`tmgr-notify: unknown hook "${sub}"\n`);
    }
  } catch (err) {
    process.stderr.write(`tmgr-notify: hook error: ${errorMessage(err)}\n`);
  } finally {
    process.exitCode = 0;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, sub, ...rest] = argv;

  if (!cmd || cmd === 'mcp') {
    await runMcpServer();
    return;
  }

  if (cmd === 'send') {
    await runSend(argv.slice(1));
    return;
  }

  if (cmd === 'alarm') {
    await runAlarm(argv.slice(1));
    return;
  }

  if (cmd === 'hook') {
    await runHook(sub, rest);
    return;
  }

  process.stderr.write(`tmgr-notify: unknown command "${cmd}"\n`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`tmgr-notify: fatal error: ${errorMessage(err)}\n`);
  process.exitCode = 1;
});
