import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChecksumError,
  MissingBinaryError,
  UnsupportedPlatformError,
  BinaryOverrideError,
  isCompatible,
  parseVersion,
  resolveBinary,
  type ResolveDeps,
} from '../src/resolve.js';

const GOOD_HASH = 'a'.repeat(64);

function makeDeps(over: Partial<ResolveDeps> & { files?: Set<string>; versions?: Record<string, string | undefined> } = {}) {
  const calls = { chmod: [] as string[], probed: [] as string[], hashed: [] as string[], order: [] as string[] };
  const files = over.files ?? new Set<string>();
  const versions = over.versions ?? {};
  const deps: ResolveDeps = {
    env: { PATH: '/bin1:/bin2' },
    platform: 'linux',
    arch: 'x64',
    release: {
      repo: 'tmgr-dev/frontend',
      tag: 'cli-v1.0.1',
      version: '1.0.1',
      minVersion: '1.0.1',
      platforms: { 'linux-x64': { binarySha256: GOOD_HASH } },
    },
    isFile: (p) => files.has(p),
    isExecutable: () => true,
    mode: () => 0o644,
    chmod: (p) => {
      calls.chmod.push(p);
      calls.order.push('chmod');
    },
    versionOutput: (p) => {
      calls.probed.push(p);
      return versions[p];
    },
    packageDir: () => '/pkg',
    sha256: async (p) => {
      calls.hashed.push(p);
      calls.order.push('hash');
      return GOOD_HASH;
    },
    debug: () => {},
    ...over,
  };
  return { deps, calls };
}

test('parseVersion accepts strict versions only', () => {
  assert.deepEqual(parseVersion('tmgr 1.2.3\n'), [1, 2, 3]);
  assert.deepEqual(parseVersion('tmgr 1.2.3-beta.1\nmore'), [1, 2, 3]);
  assert.deepEqual(parseVersion('tmgr 1.2.3+build5'), [1, 2, 3]);
  assert.equal(parseVersion('tmgr 1.2'), undefined);
  assert.equal(parseVersion('something tmgr 1.2.3'), undefined);
  assert.equal(parseVersion('garbage'), undefined);
  assert.equal(parseVersion(''), undefined);
  assert.equal(parseVersion(undefined), undefined);
});

test('isCompatible enforces min version and major < 2', () => {
  assert.equal(isCompatible([1, 0, 1], '1.0.1'), true);
  assert.equal(isCompatible([1, 2, 0], '1.0.1'), true);
  assert.equal(isCompatible([1, 0, 0], '1.0.1'), false);
  assert.equal(isCompatible([0, 9, 9], '1.0.1'), false);
  assert.equal(isCompatible([2, 0, 0], '1.0.1'), false);
});

test('TMGR_BIN wins and is not hash-checked or probed', async () => {
  const { deps, calls } = makeDeps({ files: new Set(['/x/tmgr', '/bin1/tmgr']) });
  deps.env = { PATH: '/bin1', TMGR_BIN: '/x/tmgr' };
  assert.deepEqual(await resolveBinary(deps), { path: '/x/tmgr', source: 'TMGR_BIN' });
  assert.deepEqual(calls.probed, []);
  assert.deepEqual(calls.hashed, []);
});

test('TMGR_BIN pointing nowhere is an error', async () => {
  const { deps } = makeDeps();
  deps.env = { PATH: '/bin1', TMGR_BIN: '/missing/tmgr' };
  await assert.rejects(resolveBinary(deps), BinaryOverrideError);
});

test('PATH tmgr with a good version is used', async () => {
  const { deps } = makeDeps({ files: new Set(['/bin2/tmgr']), versions: { '/bin2/tmgr': 'tmgr 1.0.1\n' } });
  assert.deepEqual(await resolveBinary(deps), { path: '/bin2/tmgr', source: 'PATH' });
});

test('PATH tmgr that is too old, 2.x, garbage or timed out falls through to the package', async () => {
  for (const out of ['tmgr 1.0.0\n', 'tmgr 2.0.0\n', 'hello', undefined]) {
    const { deps, calls } = makeDeps({
      files: new Set(['/bin1/tmgr', '/pkg/bin/tmgr']),
      versions: { '/bin1/tmgr': out },
    });
    assert.deepEqual(await resolveBinary(deps), { path: '/pkg/bin/tmgr', source: 'package' });
    assert.deepEqual(calls.probed, ['/bin1/tmgr']);
  }
});

test('non-executable PATH entries are skipped', async () => {
  const { deps, calls } = makeDeps({ files: new Set(['/bin1/tmgr', '/pkg/bin/tmgr']), isExecutable: () => false });
  assert.equal((await resolveBinary(deps)).source, 'package');
  assert.deepEqual(calls.probed, []);
});

test('win32 is reported as unsupported with WSL2 guidance', async () => {
  const { deps } = makeDeps({ platform: 'win32', arch: 'x64' });
  await assert.rejects(resolveBinary(deps), (err: Error) => {
    assert.ok(err instanceof UnsupportedPlatformError);
    assert.match(err.message, /Windows is not supported natively/);
    assert.match(err.message, /WSL2/);
    assert.match(err.message, /TMGR_BIN/);
    return true;
  });
});

test('unsupported arch is reported', async () => {
  const { deps } = makeDeps({ arch: 'ia32' });
  await assert.rejects(resolveBinary(deps), UnsupportedPlatformError);
});

test('missing platform package explains how to fix it', async () => {
  const { deps } = makeDeps({ packageDir: () => undefined });
  await assert.rejects(resolveBinary(deps), (err: Error) => {
    assert.ok(err instanceof MissingBinaryError);
    assert.match(err.message, /--omit=optional/);
    assert.match(err.message, /releases\/tag\/cli-v1\.0\.1/);
    assert.match(err.message, /TMGR_BIN/);
    return true;
  });
});

test('checksum mismatch throws and never probes, chmods or returns the binary', async () => {
  const { deps, calls } = makeDeps({ files: new Set(['/pkg/bin/tmgr']), sha256: async () => 'b'.repeat(64) });
  await assert.rejects(resolveBinary(deps), (err: Error) => {
    assert.ok(err instanceof ChecksumError);
    assert.match(err.message, /refusing to run/);
    assert.ok(err.message.includes('a'.repeat(64)) && err.message.includes('b'.repeat(64)));
    return true;
  });
  assert.deepEqual(calls.chmod, []);
  assert.deepEqual(calls.probed, []);
});

test('chmod happens only after verification and only when not executable', async () => {
  const { deps, calls } = makeDeps({ files: new Set(['/pkg/bin/tmgr']) });
  assert.equal((await resolveBinary(deps)).source, 'package');
  assert.deepEqual(calls.order, ['hash', 'chmod']);

  const exec = makeDeps({ files: new Set(['/pkg/bin/tmgr']), mode: () => 0o755 });
  await resolveBinary(exec.deps);
  assert.deepEqual(exec.calls.chmod, []);
});

test('relative and empty PATH entries are never searched', async () => {
  const { deps, calls } = makeDeps({
    files: new Set(['tmgr', 'bin/tmgr', '/pkg/bin/tmgr']),
    versions: { tmgr: 'tmgr 1.0.1', 'bin/tmgr': 'tmgr 1.0.1' },
  });
  deps.env = { PATH: ':.:bin' };
  assert.equal((await resolveBinary(deps)).source, 'package');
  assert.deepEqual(calls.probed, []);
});
