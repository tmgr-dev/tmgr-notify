import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstLine } from '../src/message.js';

test('firstLine returns the first non-empty line', () => {
  assert.equal(firstLine('hello\nworld'), 'hello');
});

test('firstLine skips leading blank lines', () => {
  assert.equal(firstLine('\n\nhello'), 'hello');
});

test('firstLine trims surrounding whitespace', () => {
  assert.equal(firstLine('  hello  \nworld'), 'hello');
});

test('firstLine falls back when the input is empty or blank', () => {
  assert.equal(firstLine(undefined, 'fallback'), 'fallback');
  assert.equal(firstLine(null, 'fallback'), 'fallback');
  assert.equal(firstLine('', 'fallback'), 'fallback');
  assert.equal(firstLine('   \n  ', 'fallback'), 'fallback');
});
