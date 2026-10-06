/**
 * Differential test: this plugin's range evaluator against the real
 * node-semver that DSH itself uses, when one is installed next to the profile.
 *
 * DSH calls `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.
 * Whenever that package is resolvable the two must agree over the matrix below;
 * otherwise the test is skipped, and the unit expectations in host.test.mjs
 * remain the contract.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { satisfies } from '../lib/semver.js';

const CANDIDATES = [
  '/Users/louis/.dsh/profiles/node_modules/semver/package.json',
  '/Users/louis/.dsh/profiles/desktop/node_modules/semver/package.json',
  '/Users/louis/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/semver/package.json',
];

function loadSemver() {
  for (const candidate of CANDIDATES) {
    try {
      const require = createRequire(candidate);
      return require('semver');
    } catch {
      /* try the next location */
    }
  }
  return null;
}

const VERSIONS = [
  '0.1.0-rc.1',
  '0.1.0-rc.5',
  '0.1.0-rc.6',
  '0.1.0-rc.7',
  '0.1.7-rc.1',
  '0.2.0-rc.2',
  '0.2.0',
  '0.2.1',
  '0.3.0-0',
  '1.0.0',
  '1.2.3',
  '1.2.4-rc.1',
  '2.0.0',
];

const RANGES = [
  '*',
  'x',
  '0.2.0-rc.2',
  '>=0.1.7-rc.1 <0.3.0-0',
  '>=0.1.0-rc.5 <0.2.0',
  '>=0.1.0-rc.7 <0.2.0-0 || >=0.1.1-rc.1 <0.2.0-0',
  '^0.1.0',
  '^0.2.0',
  '^1.2.0',
  '^0.0.3',
  '~0.2.0',
  '~1.2.3',
  '~1.2',
  '~1',
  '1.x',
  '1.2.x',
  '>=1.2.3',
  '>1.2.3',
  '<=1.2.3',
  '<1.2',
  '>1.2',
  '=1.2',
  '1.2 - 1.4',
  '1.2.3 - 1.2.4',
  '>=0.1.0 <0.2.0 || >=1.0.0',
];

test('range evaluator agrees with node-semver when available', (t) => {
  const semver = loadSemver();
  if (semver === null) {
    t.skip('node-semver not installed next to this profile');
    return;
  }
  const mismatches = [];
  for (const version of VERSIONS) {
    for (const range of RANGES) {
      const expected = semver.satisfies(version, range, { includePrerelease: true });
      const actual = satisfies(version, range);
      if (expected !== actual) mismatches.push(`${version} ${range}: expected ${expected}, got ${actual}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('range evaluator survives a generated matrix', (t) => {
  const semver = loadSemver();
  if (semver === null) {
    t.skip('node-semver not installed next to this profile');
    return;
  }
  const versions = [];
  for (const major of [0, 1, 2]) {
    for (const minor of [0, 1, 2]) {
      for (const patch of [0, 3]) {
        versions.push(`${major}.${minor}.${patch}`, `${major}.${minor}.${patch}-0`, `${major}.${minor}.${patch}-rc.1`);
      }
    }
  }
  const operators = ['', '=', '>', '>=', '<', '<=', '^', '~'];
  const partials = ['0.0.0', '1.2.3', '1.2', '1', '0.2', '1.2.x', '1.x', '0.0.3'];
  const extra = ['*', '1.2.3 - 2.0.0', '1.2 - 1.4', '>=1.0.0 <2.0.0 || >=2.1.0', '>=0.0.0-0', '^0.0.3', '~0.2.3'];
  const ranges = [...extra];
  for (const operator of operators) {
    for (const partial of partials) ranges.push(`${operator}${partial}`);
  }
  const mismatches = [];
  for (const version of versions) {
    for (const range of ranges) {
      const expected = semver.satisfies(version, range, { includePrerelease: true });
      const actual = satisfies(version, range);
      if (expected !== actual) mismatches.push(`${version} ${range}: expected ${expected}, got ${actual}`);
    }
  }
  assert.deepEqual(mismatches.slice(0, 20), []);
});
