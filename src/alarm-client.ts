import type { AlarmInfo, AlarmRequest, AlarmResult, AlarmWaitResult } from './types.js';

export interface AlarmClientOptions {
  alarmsUrl: string;
  token: string;
  timeoutMs?: number;
}

export interface WaitOptions extends AlarmClientOptions {
  maxWaitSeconds?: number;
  pollSeconds?: number;
  pollDelayMs?: number;
  retryDelaysMs?: number[];
  onUpdate?: (alarm: AlarmInfo) => void | Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_POLL_SECONDS = 50;
const DEFAULT_MAX_WAIT_SECONDS = 600;
const DEFAULT_POLL_DELAY_MS = 1000;
const POLL_GRACE_MS = 10000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 10000;

const TERMINAL = new Set(['acknowledged', 'no_answer', 'busy', 'failed', 'call_unavailable', 'expired']);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

function parseAlarm(json: unknown): AlarmInfo | undefined {
  const root = json as { data?: unknown } | null;
  const candidate = (root && typeof root === 'object' && root.data && typeof root.data === 'object' ? root.data : json) as
    | Partial<AlarmInfo>
    | null;
  if (!candidate || typeof candidate !== 'object' || candidate.id === undefined || typeof candidate.status !== 'string') {
    return undefined;
  }
  return { ...candidate, id: String(candidate.id), status: candidate.status } as AlarmInfo;
}

async function request(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  opts: AlarmClientOptions,
  timeoutMs: number
): Promise<AlarmResult> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 200 || res.status === 201 || res.status === 202) {
      const alarm = parseAlarm(await res.json().catch(() => undefined));
      if (!alarm) return { ok: false, kind: 'error', message: 'unexpected response body' };
      return { ok: true, alarm };
    }

    if (res.status === 429) {
      const header = res.headers.get('retry-after');
      const retryAfter = header ? Number(header) : undefined;
      return {
        ok: false,
        kind: 'rate_limited',
        message: 'rate limited',
        transient: true,
        ...(retryAfter !== undefined && Number.isFinite(retryAfter) ? { retryAfter } : {}),
      };
    }

    if (res.status === 401) {
      return { ok: false, kind: 'unauthorized', message: 'unauthorized' };
    }

    if (res.status === 404) {
      return { ok: false, kind: 'error', message: 'alarm not found' };
    }

    const text = await res.text().catch(() => '');
    if (res.status === 400) {
      return { ok: false, kind: 'validation', message: text || 'validation error' };
    }
    return {
      ok: false,
      kind: 'error',
      message: `unexpected status ${res.status}${text ? `: ${text}` : ''}`,
      ...(res.status >= 500 ? { transient: true } : {}),
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    return {
      ok: false,
      kind: 'error',
      message: isTimeout ? 'request timed out' : err instanceof Error ? err.message : String(err),
      transient: true,
    };
  }
}

export function createAlarm(req: AlarmRequest, opts: AlarmClientOptions): Promise<AlarmResult> {
  return request(opts.alarmsUrl, { method: 'POST', body: req }, opts, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export function getAlarm(id: string, waitSeconds: number, opts: AlarmClientOptions): Promise<AlarmResult> {
  const wait = Math.max(0, Math.min(MAX_POLL_SECONDS, Math.ceil(waitSeconds)));
  const url = `${opts.alarmsUrl}/${encodeURIComponent(id)}?waitSeconds=${wait}`;
  return request(url, { method: 'GET' }, opts, wait * 1000 + POLL_GRACE_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForAlarm(id: string, opts: WaitOptions): Promise<AlarmWaitResult> {
  const maxWaitMs = (opts.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS) * 1000;
  const pollSeconds = Math.min(MAX_POLL_SECONDS, opts.pollSeconds ?? MAX_POLL_SECONDS);
  const pollDelayMs = opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const deadline = Date.now() + maxWaitMs;
  const retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let retries = 0;
  let last: AlarmInfo | undefined;

  for (;;) {
    const remainingMs = deadline - Date.now();
    const waitSeconds = Math.min(pollSeconds, Math.ceil(Math.max(remainingMs, 0) / 1000));
    const startedAt = Date.now();
    const result = await getAlarm(id, waitSeconds, opts);
    if (!result.ok) {
      if (!result.transient || retries >= retryDelays.length) return { ...result, alarmId: id };
      const delay =
        result.kind === 'rate_limited' && result.retryAfter !== undefined
          ? Math.min(result.retryAfter * 1000, MAX_RETRY_AFTER_MS)
          : retryDelays[retries];
      retries += 1;
      await sleep(delay);
      continue;
    }
    retries = 0;
    last = result.alarm;
    await opts.onUpdate?.(last);
    if (isTerminal(last.status)) return { ok: true, alarm: last, timedOut: false };
    if (Date.now() >= deadline) return { ok: true, alarm: last, timedOut: true };
    if (Date.now() - startedAt < pollDelayMs) await sleep(pollDelayMs);
  }
}
