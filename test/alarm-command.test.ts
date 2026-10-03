import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { executeAlarm, parseAlarmArgs } from '../src/commands/alarm.js';

async function run(
  args: string[],
  statuses: string[],
  onBody?: (body: Record<string, unknown>) => void
): Promise<{ code: number; lines: string[] }> {
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'POST') {
        onBody?.(JSON.parse(body));
        res.end(JSON.stringify({ data: { id: 3, status: 'pending' } }));
      } else {
        const status = statuses[Math.min(polls++, statuses.length - 1)];
        res.end(JSON.stringify({ data: { id: 3, status, ackChannel: status === 'acknowledged' ? 'app' : null } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const lines: string[] = [];
  try {
    const code = await executeAlarm(
      args,
      { baseUrl: `http://127.0.0.1:${port}`, token: 't', stopMinMinutes: 5 },
      (line) => lines.push(line),
      { pollDelayMs: 0 }
    );
    return { code, lines };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('parseAlarmArgs applies defaults and flags', () => {
  assert.deepEqual(parseAlarmArgs(['prod down']), { title: 'Alarm', wait: true, message: 'prod down' });
  const p = parseAlarmArgs(['--title', 'DB', 'msg', '--no-wait', '--ack-timeout', '45', '--delivery-timeout', '10']);
  assert.equal(p.title, 'DB');
  assert.equal(p.wait, false);
  assert.equal(p.ackTimeoutSeconds, 45);
  assert.equal(p.deliveryTimeoutSeconds, 10);
  assert.equal(parseAlarmArgs([]).error, 'a message is required');
});

test('exit code 0 and progress lines when acknowledged', async () => {
  let body: Record<string, unknown> = {};
  const { code, lines } = await run(['msg', '--ack-timeout', '20'], ['delivered', 'acknowledged'], (b) => (body = b));
  assert.equal(code, 0);
  assert.deepEqual(body, { title: 'Alarm', message: 'msg', ackTimeoutSeconds: 20 });
  assert.deepEqual(lines, [
    'alarm 3: pending',
    'status: delivered',
    'status: acknowledged',
    'alarm 3: acknowledged, channel: app, call: none',
  ]);
});

test('non-zero exit code when the alarm ends unacknowledged', async () => {
  const { code, lines } = await run(['msg'], ['calling', 'no_answer']);
  assert.equal(code, 1);
  assert.match(lines.at(-1) ?? '', /no_answer/);
});

test('--no-wait exits 0 right after creation', async () => {
  const { code, lines } = await run(['msg', '--no-wait'], ['pending']);
  assert.equal(code, 0);
  assert.deepEqual(lines, ['alarm 3: pending']);
});

test('missing message exits non-zero', async () => {
  const { code } = await run([], ['pending']);
  assert.equal(code, 1);
});

test('--no-call sends call:false', async () => {
  let body: Record<string, unknown> = {};
  const { code } = await run(['msg', '--no-call'], ['expired'], (b) => (body = b));
  assert.equal(code, 1);
  assert.equal(body.call, false);
});

test('call is omitted by default', async () => {
  let body: Record<string, unknown> = {};
  await run(['msg', '--no-wait'], ['pending'], (b) => (body = b));
  assert.equal('call' in body, false);
});
