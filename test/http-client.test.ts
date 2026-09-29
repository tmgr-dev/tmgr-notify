import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { sendPush } from '../src/http-client.js';

async function withServer(handler: http.RequestListener, fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('sendPush returns ok+sent on a 202 response', async () => {
  await withServer(
    (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        assert.equal(JSON.parse(body).title, 'hi');
        assert.equal(req.headers.authorization, 'Bearer test-token');
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { status: 'sent', channels: ['expo'] } }));
      });
    },
    async (url) => {
      const result = await sendPush({ title: 'hi' }, { endpoint: url, token: 'test-token' });
      assert.deepEqual(result, { ok: true, status: 'sent', channels: ['expo'] });
    }
  );
});

test('sendPush surfaces a 429 with the Retry-After header', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(429, { 'retry-after': '30' });
      res.end();
    },
    async (url) => {
      const result = await sendPush({ title: 'hi' }, { endpoint: url, token: 'test-token' });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.kind, 'rate_limited');
        assert.equal(result.retryAfter, 30);
      }
    }
  );
});

test('sendPush surfaces a 401 as unauthorized', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(401);
      res.end();
    },
    async (url) => {
      const result = await sendPush({ title: 'hi' }, { endpoint: url, token: 'bad-token' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.kind, 'unauthorized');
    }
  );
});

test('sendPush surfaces a client-side timeout as an error', async () => {
  await withServer(
    () => {},
    async (url) => {
      const result = await sendPush({ title: 'hi' }, { endpoint: url, token: 'test-token', timeoutMs: 100 });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.kind, 'error');
    }
  );
});
