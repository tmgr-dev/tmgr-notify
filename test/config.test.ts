import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEndpoint, ConfigError, normalizeBaseUrl, parseEnvFile, resolveConfig } from '../src/config.js';

test('parseEnvFile parses KEY=VALUE lines, skips comments, blanks and strips quotes', () => {
  const content = '# comment\nTMGR_URL=https://example.test\n\nTMGR_NOTIFY_TOKEN="abc123"\n';
  assert.deepEqual(parseEnvFile(content), {
    TMGR_URL: 'https://example.test',
    TMGR_NOTIFY_TOKEN: 'abc123',
  });
});

test('normalizeBaseUrl strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://example.test/'), 'https://example.test');
  assert.equal(normalizeBaseUrl('https://example.test'), 'https://example.test');
});

test('normalizeBaseUrl strips a trailing /api segment', () => {
  assert.equal(normalizeBaseUrl('https://example.test/api/'), 'https://example.test');
  assert.equal(normalizeBaseUrl('https://example.test/api'), 'https://example.test');
});

test('buildEndpoint appends the notifications path exactly once', () => {
  assert.equal(buildEndpoint('https://example.test/api/'), 'https://example.test/api/notifications/push');
  assert.equal(buildEndpoint('https://example.test'), 'https://example.test/api/notifications/push');
});

test('resolveConfig: env wins over the fallback file', () => {
  const cfg = resolveConfig(
    { TMGR_URL: 'https://env.test', TMGR_NOTIFY_TOKEN: 'env-token' },
    { TMGR_URL: 'https://file.test', TMGR_NOTIFY_TOKEN: 'file-token' }
  );
  assert.equal(cfg.baseUrl, 'https://env.test');
  assert.equal(cfg.token, 'env-token');
});

test('resolveConfig: falls back to the file when env vars are absent', () => {
  const cfg = resolveConfig({}, { TMGR_URL: 'https://file.test', TMGR_NOTIFY_TOKEN: 'file-token' });
  assert.equal(cfg.baseUrl, 'https://file.test');
  assert.equal(cfg.token, 'file-token');
});

test('resolveConfig: throws ConfigError when the token is missing', () => {
  assert.throws(() => resolveConfig({ TMGR_URL: 'https://env.test' }, {}), ConfigError);
});

test('resolveConfig: throws ConfigError when the URL is missing', () => {
  assert.throws(() => resolveConfig({ TMGR_NOTIFY_TOKEN: 'env-token' }, {}), ConfigError);
});

test('resolveConfig: defaults stopMinMinutes to 5', () => {
  const cfg = resolveConfig({ TMGR_URL: 'https://env.test', TMGR_NOTIFY_TOKEN: 't' }, {});
  assert.equal(cfg.stopMinMinutes, 5);
});

test('resolveConfig: reads a custom stopMinMinutes from env', () => {
  const cfg = resolveConfig(
    { TMGR_URL: 'https://env.test', TMGR_NOTIFY_TOKEN: 't', TMGR_NOTIFY_STOP_MIN_MINUTES: '2' },
    {}
  );
  assert.equal(cfg.stopMinMinutes, 2);
});

test('resolveConfig: falls back to default on an invalid stopMinMinutes', () => {
  const cfg = resolveConfig(
    { TMGR_URL: 'https://env.test', TMGR_NOTIFY_TOKEN: 't', TMGR_NOTIFY_STOP_MIN_MINUTES: 'not-a-number' },
    {}
  );
  assert.equal(cfg.stopMinMinutes, 5);
});
