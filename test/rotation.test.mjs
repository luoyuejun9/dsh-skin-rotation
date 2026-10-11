/**
 * Core rotation-policy tests: the four modes, the candidate pool, the
 * journaled write and its crash recovery, and rotation history. Everything
 * runs in throwaway fixture profiles — never the developer's real DSH_HOME.
 *
 * Run with: node --test
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  executeRotation,
  restorePrevious,
  recoverPendingTransaction,
  discoverInstalledSkins,
  activeSkinTarget,
  readState,
  writeState,
  readHistory,
  useSkin,
} from '../lib/index.js';
import { classifyPool, chooseTarget, POOL_STATUS } from '../lib/rotation.js';
import { findPendingJournal, classifyWriteState, beginTransaction } from '../lib/patch.js';

const SKINS = [
  { id: 'alpha', name: 'Alpha', wiringId: 'ui-skin-alpha', package: 'pkg-alpha', bodyAttr: 'data-alpha', order: 1 },
  { id: 'beta', name: 'Beta', wiringId: 'ui-skin-beta', package: 'pkg-beta', bodyAttr: 'data-beta', order: 2 },
  { id: 'gamma', name: 'Gamma', wiringId: 'ui-skin-gamma', package: 'pkg-gamma', bodyAttr: 'data-gamma', order: 3 },
];

/** A minimal normalized state the engine accepts. */
function st(overrides = {}) {
  return {
    version: 2,
    enabled: true,
    mode: 'random',
    exclude: new Set(),
    weights: {},
    recentRule: 'disabled',
    fixedSkin: null,
    order: [],
    seed: null,
    historyLimit: 100,
    sequentialIndex: 0,
    currentSkin: null,
    lastPicked: null,
    lastBootId: null,
    lastRotatedAt: null,
    lastClientReport: null,
    preset: null,
    presets: {},
    recentHistory: [],
    ...overrides,
  };
}

/** Build a throwaway profile with three installed skins; return its dir. */
function makeProfile(root) {
  const profileDir = join(root, 'profiles', 'demo');
  for (const skin of SKINS) {
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
    JSON.stringify({ name: 'demo-profile', private: true, dependencies: Object.fromEntries(SKINS.map((s) => [s.package, '1.0.0'])) }),
    'utf8',
  );
  return profileDir;
}

function freshContext(root) {
  const profileDir = makeProfile(root);
  const patchPaths = [join(profileDir, 'cordis.patch.yml'), join(root, 'cordis.patch.yml')];
  return { patchPaths, profileDir, bootId: 'boot-1', logger: null, state: readState(profileDir) };
}

/* -------------------------------------------------------------------------- */
/* classifyPool                                                               */
/* -------------------------------------------------------------------------- */

test('classifyPool separates compatible / excluded / incompatible', () => {
  const catalog = [
    ...SKINS,
    { id: 'deny', name: 'Deny', wiringId: 'ui-skin-deny', package: 'pkg-deny', bodyAttr: 'data-deny', order: 4,
      compatibility: { package: 'pkg-deny@1.0.0', runtimeVersion: '0.2.0-rc.2', peers: { x: '1' }, exempted: false } },
  ];
  const { skins, pool } = classifyPool(catalog, st({ exclude: new Set(['beta']) }));
  const byId = Object.fromEntries(skins.map((s) => [s.id, s]));
  assert.equal(byId.alpha.status, POOL_STATUS.COMPATIBLE);
  assert.equal(byId.beta.status, POOL_STATUS.EXCLUDED);
  assert.equal(byId.deny.status, POOL_STATUS.INCOMPATIBLE);
  assert.deepEqual(pool.map((s) => s.id).sort(), ['alpha', 'gamma']);
});

/* -------------------------------------------------------------------------- */
/* chooseTarget: the four modes                                               */
/* -------------------------------------------------------------------------- */

test('random mode never repeats the current skin while another exists', () => {
  for (let i = 0; i < 40; i += 1) {
    assert.notEqual(chooseTarget(SKINS, st(), { current: 'alpha', random: Math.random }).target.id, 'alpha');
  }
});

test('random recent-repeat prefers a non-recent skin but never blocks', () => {
  // current=alpha, recent=[beta,gamma] → usable=[beta,gamma], all recent.
  const state = st({ recentRule: 'recent-2', recentHistory: ['beta', 'gamma'] });
  const pick = chooseTarget(SKINS, state, { current: 'alpha', random: () => 0 });
  assert.equal(pick.reason, 'exhausted'); // rule could not be honored…
  assert.ok(['beta', 'gamma'].includes(pick.target.id)); // …but it still picked, never blocked
  // With only beta recent, gamma is the preferred fresh pick.
  const preferred = chooseTarget(SKINS, st({ recentRule: 'recent-2', recentHistory: ['beta'] }), { current: 'alpha', random: () => 0 });
  assert.equal(preferred.target.id, 'gamma');
  assert.equal(preferred.reason, 'ok');
  // With the rule disabled, beta (index 0) becomes reachable again.
  const noRule = chooseTarget(SKINS, st({ recentRule: 'disabled', recentHistory: ['beta', 'gamma'] }), { current: 'alpha', random: () => 0 });
  assert.equal(noRule.target.id, 'beta');
});

test('sequential mode follows state.order and advances the index', () => {
  const ordered = ['gamma', 'alpha', 'beta'];
  const first = chooseTarget(SKINS, st({ mode: 'sequential', order: ordered, sequentialIndex: 0 }), { current: null });
  assert.equal(first.target.id, 'gamma');
  const second = chooseTarget(SKINS, st({ mode: 'sequential', order: ordered, sequentialIndex: 1 }), { current: 'gamma' });
  assert.equal(second.target.id, 'alpha');
  // Wraps around without a loop.
  const wrap = chooseTarget(SKINS, st({ mode: 'sequential', order: ordered, sequentialIndex: 3 }), { current: 'beta' });
  assert.equal(wrap.target.id, 'gamma');
});

test('sequential skips excluded and missing ids safely', () => {
  const ordered = ['beta', 'ghost', 'alpha'];
  // Exclusion happens in classifyPool; chooseTarget sees only the filtered pool.
  const { pool } = classifyPool(SKINS, st({ exclude: new Set(['beta']) }));
  const pick = chooseTarget(pool, st({ mode: 'sequential', order: ordered, sequentialIndex: 0 }), { current: null });
  assert.equal(pick.target.id, 'alpha'); // beta excluded (not in pool), ghost missing → alpha
});

test('weighted mode picks in proportion and handles zero weights', () => {
  const heavy = SKINS.map((s) => ({ ...s }));
  const state = st({ mode: 'weighted', weights: { alpha: 100, beta: 0, gamma: 0 } });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(chooseTarget(heavy, state, { random: Math.random }).target.id, 'alpha');
  }
  const allZero = chooseTarget(heavy, st({ mode: 'weighted', weights: { alpha: 0, beta: 0, gamma: 0 } }), {});
  assert.equal(allZero.target, null);
  assert.equal(allZero.reason, 'no-weighted-pool');
});

test('fixed mode honors, validates, and reports its target', () => {
  const ok = chooseTarget(SKINS, st({ mode: 'fixed', fixedSkin: 'beta' }), {});
  assert.equal(ok.target.id, 'beta');
  const missing = chooseTarget(SKINS, st({ mode: 'fixed', fixedSkin: 'ghost' }), {});
  assert.equal(missing.target, null);
  assert.equal(missing.reason, 'fixed-not-installed');
});

test('an empty pool reports empty-pool, never loops', () => {
  const pick = chooseTarget([], st({}), {});
  assert.equal(pick.target, null);
  assert.equal(pick.reason, 'empty-pool');
});

/* -------------------------------------------------------------------------- */
/* executeRotation: end-to-end with the journaled write                       */
/* -------------------------------------------------------------------------- */

test('startup rotation applies the pick, writes state and history, then blocks a second boot rotation', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    const readSources = () => context.patchPaths.map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : ''));
    const before = activeSkinTarget(readSources(), discoverInstalledSkins(context.patchPaths[0]));
    const result = executeRotation(context, readState(context.profileDir), 'startup', { random: () => 0.5 });
    assert.equal(result.rotated, true);
    const catalog = discoverInstalledSkins(context.patchPaths[0]);
    const after = activeSkinTarget(readSources(), catalog);
    assert.equal(after, result.target);
    assert.ok(['alpha', 'beta', 'gamma'].includes(after));
    // State + history recorded the success.
    assert.equal(readState(context.profileDir).lastPicked, result.target);
    const history = readHistory(context.profileDir, 10);
    assert.equal(history[0].to, result.target);
    assert.equal(history[0].ok, true);
    assert.equal(history[0].trigger, 'startup');
    // Journal cleaned up.
    assert.equal(findPendingJournal(context.profileDir), null);
    // A second startup in the same boot does not re-roll.
    const again = executeRotation(context, readState(context.profileDir), 'startup', { random: () => 0.5 });
    assert.equal(again.rotated, false);
    assert.equal(again.reason, 'already-rotated');
    void before;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disabled state blocks startup but manual shuffle still runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    const off = { ...readState(context.profileDir), enabled: false };
    const blocked = executeRotation(context, off, 'startup', {});
    assert.equal(blocked.rotated, false);
    assert.equal(blocked.reason, 'disabled');
    const manual = executeRotation(context, off, 'manual', { random: () => 0 });
    assert.equal(manual.rotated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixed mode keeps the fixed skin on launch; shuffle breaks the fix once', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    const fixed = { ...readState(context.profileDir), mode: 'fixed', fixedSkin: 'gamma' };
    const first = executeRotation(context, fixed, 'startup', {});
    assert.equal(first.target, 'gamma');
    const catalog = discoverInstalledSkins(context.patchPaths[0]);
    assert.equal(activeSkinTarget(context.patchPaths.map((p) => readFileSync(p, 'utf8')), catalog), 'gamma');
    const shuffle = executeRotation(context, readState(context.profileDir), 'manual', { random: () => 0, ignoreFixed: true });
    assert.equal(shuffle.rotated, true);
    assert.notEqual(shuffle.target, 'gamma');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restorePrevious returns to the last successful usable skin and records a restore event', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    executeRotation(context, readState(context.profileDir), 'startup', { random: () => 0 }); // pick A
    const second = executeRotation(context, readState(context.profileDir), 'manual', { random: () => 0.99 }); // pick B
    const restored = restorePrevious(context, readState(context.profileDir));
    assert.equal(restored.restored, true);
    const catalog = discoverInstalledSkins(context.patchPaths[0]);
    const now = activeSkinTarget(context.patchPaths.map((p) => readFileSync(p, 'utf8')), catalog);
    assert.equal(now, restored.target);
    assert.equal(readHistory(context.profileDir, 1)[0].trigger, 'restore');
    assert.equal(readHistory(context.profileDir, 1)[0].ok, true);
    void second;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* crash recovery                                                             */
/* -------------------------------------------------------------------------- */

test('a crash after the patch writes but before commit is finished on the next boot', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    const catalog = discoverInstalledSkins(context.patchPaths[0]);
    // Simulate the crash: write patches via useSkin, keep the journal open.
    const { journalPath } = useSkin('beta', context.patchPaths, catalog, context.profileDir);
    assert.ok(existsSync(journalPath), 'journal exists for the pending transaction');
    assert.notEqual(findPendingJournal(context.profileDir), null);
    const recovered = recoverPendingTransaction(context, readState(context.profileDir));
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.reason, 'completed');
    assert.equal(findPendingJournal(context.profileDir), null);
    // The switched target survives and state now points at it.
    assert.equal(activeSkinTarget(context.patchPaths.map((p) => readFileSync(p, 'utf8')), catalog), 'beta');
    assert.equal(readState(context.profileDir).currentSkin, 'beta');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crash with no writes yet leaves files untouched and rolls back cleanly', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    const originals = context.patchPaths.map((path) => ({ path, existed: existsSync(path), source: existsSync(path) ? readFileSync(path, 'utf8') : '' }));
    // A journal exists but no patch file was written (crash before the first write).
    beginTransaction(context.profileDir, 'beta', originals);
    assert.notEqual(findPendingJournal(context.profileDir), null);
    const recovered = recoverPendingTransaction(context, readState(context.profileDir));
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.reason, 'nothing-to-roll-back');
    assert.equal(findPendingJournal(context.profileDir), null);
    // Files are untouched: still absent (they never existed).
    for (const original of originals) {
      assert.equal(existsSync(original.path), original.existed);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery refuses to overwrite files it cannot explain', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    const catalog = discoverInstalledSkins(context.patchPaths[0]);
    useSkin('beta', context.patchPaths, catalog, context.profileDir);
    // A human (or another plugin) edits a patch after the crash.
    const edited = `${readFileSync(context.patchPaths[0], 'utf8')}\n# hand-edited\n`;
    writeFileSync(context.patchPaths[0], edited, 'utf8');
    const recovered = recoverPendingTransaction(context, readState(context.profileDir));
    assert.equal(recovered.recovered, false);
    assert.equal(recovered.reason, 'conflict');
    // The hand edit survives untouched.
    assert.ok(readFileSync(context.patchPaths[0], 'utf8').includes('# hand-edited'));
    assert.ok(readdirSync(context.profileDir).some((n) => n.endsWith('.tx.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history is bounded and never records a failure as success', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    const small = { ...readState(context.profileDir), historyLimit: 5 };
    writeState(context.profileDir, small); // persist the lower bound first
    // 7 successful rotations with only 3 skins → bounded at 5.
    for (let i = 0; i < 7; i += 1) {
      executeRotation(context, readState(context.profileDir), 'manual', { random: () => (i % 3) / 3 });
    }
    const history = readHistory(context.profileDir, 100);
    assert.ok(history.length <= 5, `history bounded at 5, got ${history.length}`);
    assert.ok(history.every((record) => record.ok === true));
    assert.ok(history.every((record) => typeof record.at === 'string'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('weights persist through state and feed the weighted picker', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-rotation-'));
  try {
    const context = freshContext(root);
    const weighted = { ...readState(context.profileDir), mode: 'weighted', weights: { alpha: 1, beta: 0, gamma: 0 } };
    // Persist via writeState path used by the route.
    writeState(context.profileDir, weighted);
    const reloaded = readState(context.profileDir);
    assert.equal(reloaded.weights.alpha, 1);
    assert.equal(reloaded.weights.beta, 0);
    const pick = chooseTarget(discoverInstalledSkins(context.patchPaths[0]), reloaded, { random: () => 0.99 });
    assert.equal(pick.target.id, 'alpha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
