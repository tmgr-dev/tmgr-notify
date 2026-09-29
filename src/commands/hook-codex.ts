import path from 'node:path';
import { extractCodexJson, parseCodexNotification } from '../codex.js';
import { buildEndpoint, loadConfig } from '../config.js';
import { sendPush } from '../http-client.js';
import { firstLine } from '../message.js';
import { buildPushPayload } from '../payload.js';

export async function runHookCodex(args: string[]): Promise<void> {
  const notification = parseCodexNotification(extractCodexJson(args));
  if (!notification || notification.type !== 'agent-turn-complete') return;

  const config = loadConfig();
  const cwd = notification.cwd || process.cwd();
  const project = path.basename(cwd) || 'project';
  const body = firstLine(notification['last-assistant-message'] ?? undefined, 'Codex finished.');

  const payload = buildPushPayload({
    title: `Codex · ${project}`,
    body,
    priority: 'normal',
    source: `codex:${project}`,
  });

  await sendPush(payload, { endpoint: buildEndpoint(config.baseUrl), token: config.token });
}
