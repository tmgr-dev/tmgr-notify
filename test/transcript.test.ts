import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastUserPromptTimestamp } from '../src/transcript.js';

test('lastUserPromptTimestamp finds the latest real user prompt', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' }, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'reply' }, timestamp: '2026-01-01T00:00:05.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' }, timestamp: '2026-01-01T00:01:00.000Z' }),
  ].join('\n');
  assert.equal(lastUserPromptTimestamp(lines), Date.parse('2026-01-01T00:01:00.000Z'));
});

test('lastUserPromptTimestamp ignores tool-result "user" entries', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'prompt' }, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
      timestamp: '2026-01-01T00:05:00.000Z',
    }),
  ].join('\n');
  assert.equal(lastUserPromptTimestamp(lines), Date.parse('2026-01-01T00:00:00.000Z'));
});

test('lastUserPromptTimestamp returns undefined for empty or malformed content', () => {
  assert.equal(lastUserPromptTimestamp(''), undefined);
  assert.equal(lastUserPromptTimestamp('not json\n{bad'), undefined);
});
