import path from 'node:path';
import { buildEndpoint, loadConfig } from '../config.js';
import { sendPush } from '../http-client.js';
import { firstLine } from '../message.js';
import { buildPushPayload } from '../payload.js';
import { readStdin } from '../stdin.js';

const NOT_NEEDS_INPUT_TYPES = new Set(['auth_success', 'elicitation_complete', 'elicitation_response']);

interface NotificationInput {
  session_id?: string;
  cwd?: string;
  message?: string;
  notification_type?: string;
}

export async function runHookNotification(): Promise<void> {
  const raw = await readStdin();
  let input: NotificationInput;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (input.notification_type && NOT_NEEDS_INPUT_TYPES.has(input.notification_type)) return;

  const config = loadConfig();
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const project = path.basename(cwd) || 'project';
  const body = firstLine(input.message, 'Claude Code needs your attention.');

  const payload = buildPushPayload({
    title: `Claude Code · ${project} · needs you`,
    body,
    priority: 'high',
    source: `claude-code:${project}`,
  });

  await sendPush(payload, { endpoint: buildEndpoint(config.baseUrl), token: config.token });
}
