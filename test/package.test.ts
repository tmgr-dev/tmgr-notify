import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));

test('package has no runtime or optional dependencies and ships cli-release.json', () => {
  const pkg = read('package.json');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.ok(pkg.files.includes('cli-release.json'));
});
