import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanupOldEntries, consumePromptStart, recordPromptStart, shouldNotifyOnStop } from '../src/state.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmgr-notify-test-'));
}

test('shouldNotifyOnStop: false when there is no recorded start time', () => {
  assert.equal(shouldNotifyOnStop(undefined, Date.now(), 5), false);
});

test('shouldNotifyOnStop: false below the threshold', () => {
  const now = 1_000_000;
  assert.equal(shouldNotifyOnStop(now - 4 * 60_000, now, 5), false);
});

test('shouldNotifyOnStop: true at or above the threshold', () => {
  const now = 1_000_000;
  assert.equal(shouldNotifyOnStop(now - 5 * 60_000, now, 5), true);
  assert.equal(shouldNotifyOnStop(now - 6 * 60_000, now, 5), true);
});

test('recordPromptStart / consumePromptStart round-trip and delete the entry', () => {
  const dir = tmpDir();
  recordPromptStart('session-1', 12345, dir);
  assert.equal(consumePromptStart('session-1', dir), 12345);
  assert.equal(consumePromptStart('session-1', dir), undefined);
});

test('recordPromptStart sanitizes the session id used for the filename', () => {
  const dir = tmpDir();
  recordPromptStart('../../etc/passwd', 1, dir);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('..'));
});

test('cleanupOldEntries removes only stale files', () => {
  const dir = tmpDir();
  recordPromptStart('old', 1, dir);
  recordPromptStart('fresh', 2, dir);
  const past = Date.now() - 48 * 60 * 60 * 1000;
  fs.utimesSync(path.join(dir, 'old.json'), new Date(past), new Date(past));

  cleanupOldEntries(dir, 24 * 60 * 60 * 1000, Date.now());

  assert.deepEqual(fs.readdirSync(dir), ['fresh.json']);
});
