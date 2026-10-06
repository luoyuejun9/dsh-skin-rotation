/**
 * Host-half tests: the managed-block surgery, discovery against the live
 * desktop profile, the random pick, and the two-layer write.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activeSkinTarget,
  admissibleSkins,
  catalogEntry,
  describeRotation,
  discoverInstalledSkins,
  enabledSkins,
  hostBootKey,
  pickTarget,
  readState,
  rotateOnLaunch,
  renderManagedBlock,
  readSkinStates,
  resolveProfilePatch,
  satisfies,
  stripManagedBlock,
  switchPatch,
  useSkin,
  writeState,
  MANAGED_END,
  MANAGED_START,
  patchTargetsForProfile,
} from '../lib/index.js';

const REAL_PROFILE_PATCH = '/Users/louis/.dsh/profiles/desktop/cordis.patch.yml';

const CATALOG = [
  { id: 'alpha', name: 'Alpha', wiringId: 'ui-skin-alpha', package: 'pkg-alpha', bodyAttr: 'data-alpha', order: 1 },
  { id: 'beta', name: 'Beta', wiringId: 'ui-skin-beta', package: 'pkg-beta', bodyAttr: 'data-beta', order: 2 },
];

const USER_PATCH = `# user layer
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light

- id: subagent-model-selection-settings
  name: "@deepseek-ai/dsh-agent-default-model/settings"
  config:
    enabled: true

# --- dsh-skin managed (auto-generated; do not edit) ---
- id: ui-skin-alpha
  disabled: false
- id: ui-skin-beta
  disabled: true
# --- end dsh-skin managed ---
`;

test('renders one enabled row per discovered skin', () => {
  const block = renderManagedBlock('beta', CATALOG);
  assert.equal(block, `${MANAGED_START}\n- id: ui-skin-alpha\n  disabled: true\n- id: ui-skin-beta\n  disabled: false\n${MANAGED_END}`);
});

test('switchPatch replaces only the managed block and keeps user YAML', () => {
  const next = switchPatch(USER_PATCH, 'beta', CATALOG);
  assert.match(next, /# user layer/);
  assert.match(next, /preference: light/);
  assert.match(next, /subagent-model-selection-settings/);
  assert.equal((next.match(/- id: ui-skin-alpha/g) ?? []).length, 1);
  assert.match(next, /- id: ui-skin-alpha\n  disabled: true/);
  assert.match(next, /- id: ui-skin-beta\n  disabled: false/);
  assert.equal((next.match(new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1);
});

test('switchPatch is idempotent for the same target', () => {
  const once = switchPatch(USER_PATCH, 'beta', CATALOG);
  const twice = switchPatch(once, 'beta', CATALOG);
  assert.equal(twice, once);
});

test('switchPatch removes an empty root sequence and appends the block', () => {
  const next = switchPatch('[]\n', 'alpha', CATALOG);
  assert.equal(next.startsWith('['), false);
  assert.equal(activeSkinTarget([next], CATALOG), 'alpha');
});

test('stripManagedBlock moves foreign rows out of the block', () => {
  const mangled = `${USER_PATCH}- id: ui-theme\n  disabled: false\n`;
  const stripped = stripManagedBlock(mangled, new Set(CATALOG.map((skin) => skin.wiringId)));
  assert.equal(stripped.includes('dsh-skin managed'), false);
  assert.equal((stripped.match(/- id: ui-theme/g) ?? []).length, 2);
});

test('stripManagedBlock refuses an unterminated block', () => {
  assert.throws(() => stripManagedBlock(`${MANAGED_START}\n- id: ui-skin-alpha\n  disabled: false\n`), /managed-section-is-incomplete/);
});

test('readSkinStates reads the last explicit value and ignores nested rows', () => {
  const states = readSkinStates(USER_PATCH, CATALOG);
  assert.equal(states.get('ui-skin-alpha'), false);
  assert.equal(states.get('ui-skin-beta'), true);
});

test('enabledSkins treats skins without any row as enabled', () => {
  const enabled = enabledSkins([''], CATALOG).map((skin) => skin.id);
  assert.deepEqual(enabled, ['alpha', 'beta']);
});

test('activeSkinTarget follows the home layer over the profile layer', () => {
  const profile = switchPatch(USER_PATCH, 'alpha', CATALOG);
  const home = switchPatch('', 'beta', CATALOG);
  assert.equal(activeSkinTarget([profile], CATALOG), 'alpha');
  assert.equal(activeSkinTarget([profile, home], CATALOG), 'beta');
});

test('activeSkinTarget falls back to official when nothing is enabled or several are', () => {
  assert.equal(activeSkinTarget([switchPatch('', 'official', CATALOG)], CATALOG), 'official');
  const twoEnabled = `${MANAGED_START}\n- id: ui-skin-alpha\n  disabled: false\n- id: ui-skin-beta\n  disabled: false\n${MANAGED_END}\n`;
  assert.equal(activeSkinTarget([twoEnabled], CATALOG), 'official');
});

test('pickTarget never repeats the current skin while another is available', () => {
  for (let index = 0; index < 50; index += 1) {
    assert.equal(pickTarget(CATALOG, 'alpha').id, 'beta');
    assert.equal(pickTarget(CATALOG, 'beta').id, 'alpha');
  }
  assert.equal(pickTarget(CATALOG, 'alpha', () => 0).id, 'beta');
  assert.equal(pickTarget([CATALOG[0]], 'alpha').id, 'alpha');
  assert.equal(pickTarget([], 'alpha'), null);
});

test('catalogEntry rejects manifests that are not skins', () => {
  assert.equal(catalogEntry({ id: 'x' }, 'pkg'), null);
  assert.equal(catalogEntry({ id: 'Bad Id', name: 'x', package: 'pkg', bodyAttr: 'data-x', wiring: { id: 'ui-skin-x' } }, 'pkg'), null);
  assert.equal(catalogEntry({ id: 'x', name: 'x', package: 'other', bodyAttr: 'data-x', wiring: { id: 'ui-skin-x' } }, 'pkg'), null);
  const good = catalogEntry({ id: 'x', name: 'X', package: 'pkg', bodyAttr: 'data-x', wiring: { id: 'ui-skin-x' } }, 'pkg');
  assert.equal(good.id, 'x');
  assert.equal(good.wiringId, 'ui-skin-x');
});

test('discovery finds the four installed skins of the live desktop profile', (t) => {
  if (!existsSync(REAL_PROFILE_PATCH)) {
    t.skip('desktop profile not present');
    return;
  }
  const catalog = discoverInstalledSkins(REAL_PROFILE_PATCH);
  const ids = catalog.map((skin) => skin.id).sort();
  assert.deepEqual(ids, ['deep-whale-day-night', 'maid-atelier', 'maid-whale-webui', 'orca-link']);
  for (const skin of catalog) {
    assert.equal(skin.package.startsWith('@') || skin.package.length > 0, true);
    assert.match(skin.bodyAttr, /^data-/);
  }
  const sources = patchTargetsForProfile(REAL_PROFILE_PATCH).map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : ''));
  assert.ok(ids.includes(activeSkinTarget(sources, catalog)) || activeSkinTarget(sources, catalog) === 'official');
  assert.equal(admissibleSkins(catalog).length, 4);
});

test('useSkin writes both layers and keeps exactly one skin enabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const profileDir = join(root, 'profiles', 'demo');
    mkdirSync(profileDir, { recursive: true });
    const patchPaths = [join(profileDir, 'cordis.patch.yml'), join(root, 'cordis.patch.yml')];
    writeFileSync(patchPaths[0], USER_PATCH, 'utf8');
    writeFileSync(patchPaths[1], `# home\n- id: ui-theme\n  config:\n    preference: dark\n`, 'utf8');

    useSkin('beta', patchPaths, CATALOG);
    const sources = patchPaths.map((path) => readFileSync(path, 'utf8'));
    for (const source of sources) {
      assert.equal(source.includes('preference:'), source.match(/preference: (light|dark)/) !== null);
    }
    assert.equal(activeSkinTarget(sources, CATALOG), 'beta');
    assert.deepEqual(enabledSkins(sources, CATALOG).map((skin) => skin.id), ['beta']);

    useSkin('official', patchPaths, CATALOG);
    const official = patchPaths.map((path) => readFileSync(path, 'utf8'));
    assert.equal(activeSkinTarget(official, CATALOG), 'official');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('useSkin refuses an unknown target and leaves files untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const path = join(root, 'cordis.patch.yml');
    writeFileSync(path, USER_PATCH, 'utf8');
    assert.throws(() => useSkin('nope', [path], CATALOG), /skin-not-installed/);
    assert.equal(readFileSync(path, 'utf8'), USER_PATCH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('state defaults to enabled and round-trips', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    assert.deepEqual(readState(root), {
      enabled: true,
      lastPicked: null,
      lastBootId: null,
      lastRotatedAt: null,
      lastClientReport: null,
    });
    writeState(root, { enabled: false, lastPicked: 'alpha', lastBootId: 'b1', lastRotatedAt: 7 });
    assert.equal(readState(root).enabled, false);
    assert.equal(readState(root).lastPicked, 'alpha');
    writeState(root, { enabled: true, lastClientReport: { at: 5, mounted: true, found: true, rendered: true } });
    assert.deepEqual(readState(root).lastClientReport, { at: 5, mounted: true, found: true, rendered: true });
    writeState(root, { enabled: true, lastClientReport: { at: 'nope' } });
    assert.deepEqual(readState(root).lastClientReport, { at: 0, mounted: false, found: false, rendered: false });
    writeFileSync(join(root, '.dsh-skin-rotation.json'), 'not json', 'utf8');
    assert.equal(readState(root).enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('describeRotation reports the live catalog and picks', (t) => {
  if (!existsSync(REAL_PROFILE_PATCH)) {
    t.skip('desktop profile not present');
    return;
  }
  const patchPaths = patchTargetsForProfile(REAL_PROFILE_PATCH);
  const payload = describeRotation({
    patchPaths,
    profileDir: '/Users/louis/.dsh/profiles/desktop',
    state: { enabled: true, lastPicked: 'maid-atelier', lastBootId: 'boot-1', lastRotatedAt: 1 },
    bootId: 'boot-1',
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.skins.length, 4);
  assert.ok(['maid-atelier', 'deep-whale-day-night', 'maid-whale-webui', 'orca-link', 'official'].includes(payload.current));
  assert.equal(payload.pickedThisBoot, 'maid-atelier');
  assert.equal(typeof payload.pickedBodyAttr, 'string');
});

/** Build a throwaway profile with two installed skins. */
function makeSkinProfile(root) {
  const profileDir = join(root, 'profiles', 'demo');
  const skins = [
    { package: 'demo-alpha', id: 'alpha', wiringId: 'ui-skin-alpha', bodyAttr: 'data-alpha', name: 'Alpha' },
    { package: 'demo-beta', id: 'beta', wiringId: 'ui-skin-beta', bodyAttr: 'data-beta', name: 'Beta' },
  ];
  for (const skin of skins) {
    const dir = join(profileDir, 'node_modules', skin.package);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: skin.package, version: '1.0.0' }), 'utf8');
    writeFileSync(
      join(dir, 'skin.json'),
      JSON.stringify({ id: skin.id, name: skin.name, package: skin.package, bodyAttr: skin.bodyAttr, wiring: { id: skin.wiringId } }),
      'utf8',
    );
  }
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'demo-profile', private: true, dependencies: Object.fromEntries(skins.map((skin) => [skin.package, '1.0.0'])) }),
    'utf8',
  );
  return profileDir;
}

test('a launch rotates once and a second apply in the same process does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const profileDir = makeSkinProfile(root);
    const patchPaths = [join(profileDir, 'cordis.patch.yml'), join(root, 'cordis.patch.yml')];
    const context = { patchPaths, profileDir, bootId: 'boot-A', state: readState(profileDir) };
    const first = rotateOnLaunch(context, readState(profileDir), () => 0.99);
    assert.equal(first.rotated, true);
    assert.ok(['alpha', 'beta'].includes(first.target));
    const sources = patchPaths.map((path) => readFileSync(path, 'utf8'));
    assert.equal(activeSkinTarget(sources, discoverInstalledSkins(patchPaths[0])), first.target);
    assert.equal(readState(profileDir).lastBootId, 'boot-A');

    const second = rotateOnLaunch(context, readState(profileDir), () => 0);
    assert.equal(second.rotated, false);
    assert.equal(second.reason, 'already-rotated');
    assert.equal(activeSkinTarget(patchPaths.map((path) => readFileSync(path, 'utf8')), discoverInstalledSkins(patchPaths[0])), first.target);

    const off = rotateOnLaunch(context, { ...readState(profileDir), enabled: false }, () => 0);
    assert.equal(off.rotated, false);
    assert.equal(off.reason, 'disabled');

    const next = rotateOnLaunch({ ...context, bootId: 'boot-B' }, readState(profileDir), () => 0);
    assert.equal(next.rotated, true);
    assert.notEqual(next.target, first.target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the host boot key is stable inside one process and new after a restart', () => {
  const first = hostBootKey();
  assert.equal(hostBootKey(), first);
  assert.match(first, new RegExp(`^${process.pid}-`));
  delete globalThis[Symbol.for('dsh-skin-rotation.host-boot-key')];
  const second = hostBootKey();
  assert.notEqual(second, first);
  assert.match(second, new RegExp(`^${process.pid}-`));
});

test('satisfies covers the range grammar plugins publish', () => {
  assert.equal(satisfies('0.2.0-rc.2', '>=0.1.7-rc.1 <0.3.0-0'), true);
  assert.equal(satisfies('0.2.0-rc.2', '>=0.1.0-rc.5 <0.2.0'), true);
  assert.equal(satisfies('0.2.0-rc.2', '>=0.1.0-rc.7 <0.2.0-0 || >=0.1.1-rc.1 <0.2.0-0'), false);
  assert.equal(satisfies('1.2.3', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.4.0', '1.2 - 1.4'), true);
  assert.equal(satisfies('1.5.0', '1.2 - 1.4'), false);
  assert.equal(satisfies('3.1.0', '*'), true);
  assert.equal(satisfies('not-a-version', '^1.0.0'), false);
  assert.equal(satisfies('1.0.0', 'not-a-range'), false);
});
