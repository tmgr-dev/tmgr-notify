import { buildEndpoint, loadConfig } from '../config.js';
import { sendPush } from '../http-client.js';
import { buildPushPayload } from '../payload.js';
import type { Priority } from '../types.js';

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = '';
    }
  }
  return out;
}

export async function runSend(args: string[]): Promise<void> {
  const flags = parseArgs(args);
  if (!flags.title) {
    process.stderr.write('tmgr-notify send: --title is required\n');
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`tmgr-notify send: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const payload = buildPushPayload({
    title: flags.title,
    body: flags.body,
    priority: flags.priority as Priority | undefined,
    link: flags.link,
  });

  const result = await sendPush(payload, { endpoint: buildEndpoint(config.baseUrl), token: config.token });

  if (result.ok) {
    process.stdout.write(`${result.status} (channels: ${result.channels.join(', ') || 'none'})\n`);
    process.exitCode = 0;
  } else {
    const suffix = result.kind === 'rate_limited' && result.retryAfter ? ` (retry after ${result.retryAfter}s)` : '';
    process.stdout.write(`error: ${result.message}${suffix}\n`);
    process.exitCode = 1;
  }
}
