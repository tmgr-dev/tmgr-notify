import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createAlarm, getAlarm, waitForAlarm } from '../src/alarm-client.js';

async function withServer(handler: http.RequestListener, fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/api/alarms`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('createAlarm posts the body with a bearer token and unwraps {data}', async () => {
  await withServer(
    (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/api/alarms');
        assert.equal(req.headers.authorization, 'Bearer test-token');
        assert.deepEqual(JSON.parse(body), { title: 'T', message: 'M', ackTimeoutSeconds: 30 });
        json(res, 201, { data: { id: 7, status: 'pending' } });
      });
    },
    async (url) => {
      const result = await createAlarm({ title: 'T', message: 'M', ackTimeoutSeconds: 30 }, { alarmsUrl: url, token: 'test-token' });
      assert.deepEqual(result, { ok: true, alarm: { id: '7', status: 'pending' } });
    }
  );
});

test('createAlarm accepts an unwrapped {id,status} body', async () => {
  await withServer(
    (_req, res) => json(res, 202, { id: 'abc', status: 'pending' }),
    async (url) => {
      const result = await createAlarm({ title: 'T', message: 'M' }, { alarmsUrl: url, token: 't' });
      assert.deepEqual(result, { ok: true, alarm: { id: 'abc', status: 'pending' } });
    }
  );
});

test('createAlarm maps 429, 401 and 400', async () => {
  const cases: Array<[number, Record<string, string>, string, string?]> = [
    [429, { 'retry-after': '12' }, 'rate_limited'],
    [401, {}, 'unauthorized'],
    [400, {}, 'validation', 'bad title'],
  ];
  for (const [status, headers, kind, text] of cases) {
    await withServer(
      (_req, res) => {
        res.writeHead(status, headers);
        res.end(text ?? '');
      },
      async (url) => {
        const result = await createAlarm({ title: 'T', message: 'M' }, { alarmsUrl: url, token: 't' });
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.kind, kind);
          if (status === 429) assert.equal(result.retryAfter, 12);
          if (text) assert.equal(result.message, text);
        }
      }
    );
  }
});

test('getAlarm sends waitSeconds capped at 50', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/api/alarms/9?waitSeconds=50');
      json(res, 200, { data: { id: 9, status: 'delivered', callStatus: null } });
    },
    async (url) => {
      const result = await getAlarm('9', 120, { alarmsUrl: url, token: 't' });
      assert.equal(result.ok && result.alarm.status, 'delivered');
    }
  );
});

test('waitForAlarm polls until a terminal status', async () => {
  const statuses = ['pending', 'delivered', 'calling', 'acknowledged'];
  let calls = 0;
  const seen: string[] = [];
  await withServer(
    (_req, res) => {
      const status = statuses[Math.min(calls++, statuses.length - 1)];
      json(res, 200, { data: { id: 1, status, ackChannel: status === 'acknowledged' ? 'call' : null } });
    },
    async (url) => {
      const result = await waitForAlarm('1', {
        alarmsUrl: url,
        token: 't',
        pollDelayMs: 0,
        onUpdate: (a) => void seen.push(a.status),
      });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.timedOut, false);
        assert.equal(result.alarm.status, 'acknowledged');
        assert.equal(result.alarm.ackChannel, 'call');
      }
      assert.equal(calls, 4);
      assert.deepEqual(seen, statuses);
    }
  );
});

test('waitForAlarm returns the last status with timedOut when the cap is reached', async () => {
  await withServer(
    (_req, res) => json(res, 200, { data: { id: 1, status: 'delivered' } }),
    async (url) => {
      const result = await waitForAlarm('1', { alarmsUrl: url, token: 't', maxWaitSeconds: 0.3, pollDelayMs: 50 });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.timedOut, true);
        assert.equal(result.alarm.status, 'delivered');
      }
    }
  );
});

test('waitForAlarm surfaces 401 with the alarm id', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(401);
      res.end();
    },
    async (url) => {
      const result = await waitForAlarm('5', { alarmsUrl: url, token: 'bad', pollDelayMs: 0 });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.kind, 'unauthorized');
        assert.equal(result.alarmId, '5');
      }
    }
  );
});
