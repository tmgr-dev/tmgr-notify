import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractCodexJson, parseCodexNotification } from '../src/codex.js';

test('extractCodexJson takes the last argv element', () => {
  assert.equal(
    extractCodexJson(['{"type":"agent-turn-complete"}']),
    '{"type":"agent-turn-complete"}'
  );
  assert.equal(extractCodexJson([]), undefined);
});

test('parseCodexNotification parses a valid agent-turn-complete payload', () => {
  const json = JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': 'abc',
    cwd: '/repo',
    'last-assistant-message': 'done',
  });
  const parsed = parseCodexNotification(json);
  assert.equal(parsed?.type, 'agent-turn-complete');
  assert.equal(parsed?.['last-assistant-message'], 'done');
  assert.equal(parsed?.cwd, '/repo');
});

test('parseCodexNotification returns undefined for invalid or missing JSON', () => {
  assert.equal(parseCodexNotification('not json'), undefined);
  assert.equal(parseCodexNotification(undefined), undefined);
  assert.equal(parseCodexNotification('null'), undefined);
});
