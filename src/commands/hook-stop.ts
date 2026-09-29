import fs from 'node:fs/promises';
import path from 'node:path';
import { buildEndpoint, loadConfig } from '../config.js';
import { sendPush } from '../http-client.js';
import { firstLine } from '../message.js';
import { buildPushPayload } from '../payload.js';
import { readStdin } from '../stdin.js';
import { consumePromptStart, shouldNotifyOnStop } from '../state.js';
import { lastUserPromptTimestamp } from '../transcript.js';

interface StopInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

export async function runHookStop(): Promise<void> {
  const raw = await readStdin();
  let input: StopInput;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (input.stop_hook_active) return;

  const config = loadConfig();
  const now = Date.now();

  let startedAt = input.session_id ? consumePromptStart(input.session_id) : undefined;
  if (startedAt === undefined && input.transcript_path) {
    try {
      const content = await fs.readFile(input.transcript_path, 'utf8');
      startedAt = lastUserPromptTimestamp(content);
    } catch {
      startedAt = undefined;
    }
  }

  if (!shouldNotifyOnStop(startedAt, now, config.stopMinMinutes)) return;

  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const project = path.basename(cwd) || 'project';
  const body = firstLine(input.last_assistant_message, 'Claude Code finished.');

  const payload = buildPushPayload({
    title: `Claude Code · ${project}`,
    body,
    priority: 'normal',
    source: `claude-code:${project}`,
  });

  await sendPush(payload, { endpoint: buildEndpoint(config.baseUrl), token: config.token });
}
