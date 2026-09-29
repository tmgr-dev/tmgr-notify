import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPushPayload } from '../src/payload.js';

test('buildPushPayload truncates title, body and source to the contract limits', () => {
  const payload = buildPushPayload({
    title: 'a'.repeat(200),
    body: 'b'.repeat(2000),
    source: 'c'.repeat(200),
  });
  assert.equal(payload.title.length, 120);
  assert.equal(payload.body?.length, 1000);
  assert.equal(payload.source?.length, 120);
});

test('buildPushPayload drops a non-http(s) link', () => {
  const payload = buildPushPayload({ title: 't', link: 'javascript:alert(1)' });
  assert.equal(payload.link, undefined);
});

test('buildPushPayload keeps an absolute http(s) link', () => {
  const payload = buildPushPayload({ title: 't', link: 'https://tmgr.dev/ws/tasks/1' });
  assert.equal(payload.link, 'https://tmgr.dev/ws/tasks/1');
});

test('buildPushPayload omits empty optional fields', () => {
  const payload = buildPushPayload({ title: 't' });
  assert.deepEqual(payload, { title: 't' });
});
