import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { optionalDependencies } from '../tools/build-platform-packages.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));

test('release optionalDependencies cover every pinned platform at the package version', () => {
  const pkg = read('package.json');
  const release = read('cli-release.json');
  assert.deepEqual(optionalDependencies(release, pkg.version), {
    '@tmgr/notify-darwin-arm64': pkg.version,
    '@tmgr/notify-darwin-x64': pkg.version,
    '@tmgr/notify-linux-arm64': pkg.version,
    '@tmgr/notify-linux-x64': pkg.version,
  });
});

test('package has no runtime dependencies and ships cli-release.json', () => {
  const pkg = read('package.json');
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.files.includes('cli-release.json'));
});
