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
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { satisfies } from '../lib/semver.js';

/**
 * Locate node-semver without hardcoding a machine layout:
 *   1. `SEMVER_ORACLE_PATH` — an explicit package.json, for unusual set-ups;
 *   2. whatever this checkout can resolve (CI installs it beside the repo);
 *   3. the shared profile node_modules under `DSH_HOME` (default `~/.dsh`),
 *      which is where a DSH installation keeps one.
 * When none of them resolves, the differential test is skipped and says so.
 */
function candidateManifests() {
  const candidates = [];
  if (process.env.SEMVER_ORACLE_PATH) candidates.push(process.env.SEMVER_ORACLE_PATH);
  try {
    candidates.push(createRequire(import.meta.url).resolve('semver/package.json'));
  } catch {
    /* not installed next to the checkout */
  }
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const profiles = join(home, 'profiles');
  candidates.push(join(profiles, 'node_modules', 'semver', 'package.json'));
  const profile = process.env.DSH_PROFILE?.trim();
  if (profile) candidates.push(join(profiles, profile, 'node_modules', 'semver', 'package.json'));
  try {
    for (const name of readdirSync(profiles)) {
      candidates.push(join(profiles, name, 'node_modules', 'semver', 'package.json'));
    }
  } catch {
    /* no profiles directory */
  }
  return candidates;
}

function loadSemver() {
  for (const candidate of candidateManifests()) {
    try {
      const require = createRequire(candidate);
      return require('semver');
    } catch {
      /* try the next candidate */
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
