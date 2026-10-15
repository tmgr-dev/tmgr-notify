import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));

test('optionalDependencies match the platforms in cli-release.json and the package version', () => {
  const pkg = read('package.json');
  const release = read('cli-release.json');
  const expected = Object.keys(release.platforms).map((k) => `@tmgr/notify-${k}`).sort();
  assert.deepEqual(Object.keys(pkg.optionalDependencies).sort(), expected);
  for (const [name, version] of Object.entries(pkg.optionalDependencies)) {
    assert.equal(version, pkg.version, name);
  }
});

test('package has no runtime dependencies and ships cli-release.json', () => {
  const pkg = read('package.json');
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.files.includes('cli-release.json'));
});
