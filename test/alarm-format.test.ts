import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAlarm } from '../src/alarm-format.js';

test('formatAlarm includes attempts when present', () => {
  assert.equal(
    formatAlarm({ id: '5', status: 'no_answer', callStatus: 'no-answer', callAttempts: 3, callAttemptsMade: 2 }),
    'alarm 5: no_answer, call: no-answer, attempts: 2/3'
  );
  assert.match(formatAlarm({ id: '5', status: 'calling', callAttempts: 3, callAttemptsMade: 0 }), /attempts: 0\/3/);
});

test('formatAlarm omits attempts when absent', () => {
  assert.equal(formatAlarm({ id: '5', status: 'pending' }), 'alarm 5: pending, call: none');
});
