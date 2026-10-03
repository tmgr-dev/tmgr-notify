import type { AlarmInfo, PushFailure } from './types.js';

export function formatAlarm(alarm: AlarmInfo, timedOut = false): string {
  const parts = [`alarm ${alarm.id}: ${alarm.status}`];
  if (alarm.ackChannel) parts.push(`channel: ${alarm.ackChannel}`);
  parts.push(`call: ${alarm.callStatus ?? 'none'}`);
  if (typeof alarm.callAttempts === 'number' && typeof alarm.callAttemptsMade === 'number') {
    parts.push(`attempts: ${alarm.callAttemptsMade}/${alarm.callAttempts}`);
  }
  if (timedOut) parts.push('timedOut: true (still not final, re-check with alarm_status)');
  return parts.join(', ');
}

export function formatAlarmFailure(failure: PushFailure, alarmId?: string): string {
  const suffix = alarmId ? ` (alarm ${alarmId} was created; re-check with alarm_status)` : '';
  if (failure.kind === 'rate_limited') {
    return `rate limited${failure.retryAfter ? ` (retry after ${failure.retryAfter}s)` : ''}${suffix}`;
  }
  if (failure.kind === 'unauthorized') return `error: unauthorized, check TMGR_NOTIFY_TOKEN${suffix}`;
  return `error: ${failure.message}${suffix}`;
}
