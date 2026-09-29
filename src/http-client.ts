import type { PushPayload, PushResult } from './types.js';

export interface HttpClientOptions {
  endpoint: string;
  token: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function sendPush(payload: PushPayload, opts: HttpClientOptions): Promise<PushResult> {
  try {
    const res = await fetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (res.status === 202) {
      const json = (await res.json()) as { data: { status: 'sent' | 'deduplicated'; channels: string[] } };
      return { ok: true, status: json.data.status, channels: json.data.channels };
    }

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      return {
        ok: false,
        kind: 'rate_limited',
        message: 'rate limited',
        ...(retryAfter !== undefined && Number.isFinite(retryAfter) ? { retryAfter } : {}),
      };
    }

    if (res.status === 401) {
      return { ok: false, kind: 'unauthorized', message: 'unauthorized' };
    }

    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      return { ok: false, kind: 'validation', message: text || 'validation error' };
    }

    const text = await res.text().catch(() => '');
    return { ok: false, kind: 'error', message: `unexpected status ${res.status}${text ? `: ${text}` : ''}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    const message = isTimeout ? 'request timed out' : err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'error', message };
  }
}
