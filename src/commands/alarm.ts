import { formatAlarm, formatAlarmFailure } from '../alarm-format.js';
import { createAlarm, waitForAlarm } from '../alarm-client.js';
import { buildAlarmsUrl, loadConfig } from '../config.js';
import type { ResolvedConfig } from '../config.js';

interface ParsedArgs {
  message?: string;
  title: string;
  wait: boolean;
  call?: boolean;
  ackTimeoutSeconds?: number;
  deliveryTimeoutSeconds?: number;
  callAttempts?: number;
  error?: string;
}

function parseNumber(flag: string, value: string | undefined): number | string {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : `${flag} needs a positive number`;
}

export function parseAlarmArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { title: 'Alarm', wait: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-wait') {
      out.wait = false;
    } else if (arg === '--no-call') {
      out.call = false;
    } else if (arg === '--title') {
      out.title = args[++i] ?? '';
    } else if (arg === '--ack-timeout' || arg === '--delivery-timeout') {
      const n = parseNumber(arg, args[++i]);
      if (typeof n === 'string') out.error = n;
      else if (arg === '--ack-timeout') out.ackTimeoutSeconds = n;
      else out.deliveryTimeoutSeconds = n;
    } else if (arg === '--call-attempts') {
      const n = parseNumber(arg, args[++i]);
      if (typeof n === 'string' || !Number.isInteger(n) || n > 5) out.error = '--call-attempts needs an integer from 1 to 5';
      else out.callAttempts = n;
    } else if (arg.startsWith('--')) {
      out.error = `unknown flag ${arg}`;
    } else if (out.message === undefined) {
      out.message = arg;
    } else {
      out.error = 'only one message argument is allowed (quote it)';
    }
  }
  if (!out.error && !out.message) out.error = 'a message is required';
  if (!out.error && !out.title) out.error = '--title needs a value';
  return out;
}

export async function executeAlarm(
  args: string[],
  config: ResolvedConfig,
  out: (line: string) => void,
  waitOverrides: { maxWaitSeconds?: number; pollDelayMs?: number; retryDelaysMs?: number[] } = {}
): Promise<number> {
  const parsed = parseAlarmArgs(args);
  if (parsed.error || !parsed.message) {
    out(`tmgr-notify alarm: ${parsed.error}`);
    return 1;
  }

  const opts = { alarmsUrl: buildAlarmsUrl(config.baseUrl), token: config.token };
  const created = await createAlarm(
    {
      title: parsed.title,
      message: parsed.message,
      ...(parsed.ackTimeoutSeconds !== undefined ? { ackTimeoutSeconds: parsed.ackTimeoutSeconds } : {}),
      ...(parsed.deliveryTimeoutSeconds !== undefined ? { deliveryTimeoutSeconds: parsed.deliveryTimeoutSeconds } : {}),
      ...(parsed.call === false ? { call: false } : {}),
      ...(parsed.callAttempts !== undefined ? { callAttempts: parsed.callAttempts } : {}),
    },
    opts
  );
  if (!created.ok) {
    out(formatAlarmFailure(created));
    return 1;
  }

  out(`alarm ${created.alarm.id}: ${created.alarm.status}`);
  if (!parsed.wait) return 0;

  let lastStatus = created.alarm.status;
  const result = await waitForAlarm(created.alarm.id, {
    ...opts,
    ...waitOverrides,
    onUpdate: (alarm) => {
      if (alarm.status !== lastStatus) {
        lastStatus = alarm.status;
        out(`status: ${alarm.status}`);
      }
    },
  });
  if (!result.ok) {
    out(formatAlarmFailure(result, created.alarm.id));
    return 1;
  }
  out(formatAlarm(result.alarm, result.timedOut));
  return result.alarm.status === 'acknowledged' ? 0 : 1;
}

export async function runAlarm(args: string[]): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`tmgr-notify alarm: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await executeAlarm(args, config, (line) => process.stdout.write(`${line}\n`));
}
