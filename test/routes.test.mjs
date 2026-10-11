/**
 * Route tests: request validation, the same-origin policy, and the shape of
 * what the UI is allowed to see. Requests are driven through the real route
 * object with a fake req/res, so the assertions cover the actual handler.
 *
 * Run with: node --test
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { makeSkinRotationRoute, readState, SKIN_ROTATION_ROUTE } from '../lib/index.js';

const SKINS = [
  { id: 'alpha', name: 'Alpha', wiringId: 'ui-skin-alpha', package: 'pkg-alpha', bodyAttr: 'data-alpha', order: 1 },
  { id: 'beta', name: 'Beta', wiringId: 'ui-skin-beta', package: 'pkg-beta', bodyAttr: 'data-beta', order: 2 },
];

function makeProfile(root) {
  const profileDir = join(root, 'profiles', 'demo');
  for (const skin of SKINS) {
    const dir = join(profileDir, 'node_modules', skin.package);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: skin.package, version: '1.0.0' }), 'utf8');
    writeFileSync(join(dir, 'skin.json'), JSON.stringify({ id: skin.id, name: skin.name, package: skin.package, bodyAttr: skin.bodyAttr, wiring: { id: skin.wiringId } }), 'utf8');
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: Object.fromEntries(SKINS.map((s) => [s.package, '1.0.0'])) }), 'utf8');
  return profileDir;
}

/** A fake Node request/response pair capturing what the handler produced. */
function exchange({ method = 'GET', headers = {}, body = undefined }) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.destroy = () => {};
  const captured = { status: 0, body: '', headers: {} };
  const res = {
    writeHead(status, extra) { captured.status = status; Object.assign(captured.headers, extra ?? {}); },
    end(text) { captured.body = text ?? ''; },
  };
  if (body !== undefined) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(payload, 'utf8'));
      req.emit('end');
    });
  } else {
    queueMicrotask(() => req.emit('end'));
  }
  return { req, res, captured };
}

async function call(route, options) {
  const { req, res, captured } = exchange(options);
  await route.handler(req, res);
  let parsed = null;
  try {
    parsed = JSON.parse(captured.body);
  } catch {
    parsed = null;
  }
  return { status: captured.status, body: parsed, raw: captured.body };
}

function makeContext(root) {
  const profileDir = makeProfile(root);
  return { patchPaths: [join(profileDir, 'cordis.patch.yml'), join(root, 'cordis.patch.yml')], profileDir, bootId: 'boot-1', logger: null, state: readState(profileDir) };
}

const SAME_ORIGIN = { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' };

test('the route path is stable', () => {
  assert.equal(SKIN_ROTATION_ROUTE, '/api/dsh/skin-rotation');
});

test('a same-origin GET returns the catalog without leaking local paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    const { status, body } = await call(route, { method: 'GET', headers: SAME_ORIGIN });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.skins.length, 2);
    assert.equal(body.mode, 'random');
    // No absolute path, home directory, or file name may reach the UI.
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(context.profileDir), false);
    assert.equal(serialized.includes('.dsh-skin-rotation'), false);
    assert.equal(serialized.includes(homedir()), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cross-site requests are rejected for reads and writes alike', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    const read = await call(route, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(read.status, 403);
    const write = await call(route, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { action: 'set-enabled', enabled: false } });
    assert.equal(write.status, 403);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an opaque or absent Origin is accepted, so the desktop shell can write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    // The desktop shell serves its page from an opaque origin and therefore
    // sends `Origin: null` on POST; a missing Origin is what curl/CLI sends.
    const cases = [
      { origin: 'null', host: '127.0.0.1:19387' },
      { host: '127.0.0.1:19387' },
      { origin: 'null', host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' },
    ];
    for (const headers of cases) {
      const { status, body } = await call(route, { method: 'POST', headers, body: { action: 'set-enabled', enabled: false } });
      assert.equal(status, 200, `expected 200 for headers ${JSON.stringify(headers)}, got ${status} ${JSON.stringify(body)}`);
    }
    const read = await call(route, { method: 'GET', headers: {} });
    assert.equal(read.status, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a genuine cross-site request is refused for reads and writes alike', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    // `Sec-Fetch-Site: cross-site` is browser-set and cannot be forged by the
    // page, so it stays the primary refusal even when Origin looks harmless.
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' },
      { 'sec-fetch-site': 'cross-site', origin: 'null', host: '127.0.0.1:19387' },
    ]) {
      const write = await call(route, { method: 'POST', headers, body: { action: 'set-enabled', enabled: false } });
      assert.equal(write.status, 403, `POST should be refused for ${JSON.stringify(headers)}`);
      assert.equal(write.body.error, 'cross-site-request-rejected');
      const read = await call(route, { method: 'GET', headers });
      assert.equal(read.status, 403, `GET should be refused for ${JSON.stringify(headers)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a foreign Origin is refused when the browser does not attest a same-site request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    const foreign = await call(route, {
      method: 'POST',
      headers: { origin: 'http://evil.example', host: '127.0.0.1:19387' },
      body: { action: 'set-enabled', enabled: false },
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error, 'origin-mismatch');
    // The refusal is recorded for diagnosis without leaking headers to the page.
    const { body } = await call(route, { method: 'GET', headers: {} });
    assert.equal(body.lastRejection.reason, 'origin-mismatch');
    assert.equal(body.lastRejection.hadOrigin, true);
    assert.equal(JSON.stringify(body.lastRejection).includes('evil'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same machine spelled differently (localhost vs 127.0.0.1) is accepted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    const { status, body } = await call(route, {
      method: 'POST',
      headers: { origin: 'http://localhost:19387', host: '127.0.0.1:19387' },
      body: { action: 'set-enabled', enabled: false },
    });
    assert.equal(status, 200, `expected the loopback alias to pass, got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the toggle persists and is reflected by the next read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    const off = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-enabled', enabled: false } });
    assert.equal(off.body.enabled, false);
    assert.equal(readState(context.profileDir).enabled, false);
    const again = await call(route, { method: 'GET', headers: SAME_ORIGIN });
    assert.equal(again.body.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bad input is rejected with an explicit error and no state change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    const statePath = join(context.profileDir, '.dsh-skin-rotation.json');
    const before = existsSync(statePath) ? readFileSync(statePath, 'utf8').toString() : '';
    const cases = [
      [{ action: 'set-enabled', enabled: 'yes' }, 'invalid-enabled'],
      [{ action: 'set-mode', mode: 'chaos' }, 'invalid-mode'],
      [{ action: 'set-mode', mode: 'fixed', fixedSkin: 'ghost' }, 'skin-not-installed'],
      [{ action: 'set-mode', mode: 'fixed' }, 'invalid-skin-id'],
      [{ action: 'set-recent-rule', rule: 'recent-99' }, 'invalid-recent-rule'],
      [{ action: 'set-excluded', id: 'ghost', excluded: true }, 'skin-not-installed'],
      [{ action: 'set-weight', id: 'alpha', weight: -1 }, 'invalid-weight'],
      [{ action: 'set-weight', id: 'alpha', weight: 'NaN' }, 'invalid-weight'],
      [{ action: 'set-weight', id: 'alpha', weight: {} }, 'invalid-weight'],
      [{ action: 'set-weight', id: 'alpha', weight: true }, 'invalid-weight'],
      [{ action: 'nope' }, 'unknown-action'],
    ];
    for (const [body, expected] of cases) {
      const { status, body: response } = await call(route, { method: 'POST', headers: SAME_ORIGIN, body });
      assert.equal(status, 400, `${JSON.stringify(body)} should be a 400`);
      assert.equal(response.error, expected, `${JSON.stringify(body)} → ${response.error}`);
    }
    assert.equal(existsSync(statePath) ? readFileSync(statePath, 'utf8').toString() : '', before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid JSON and oversized bodies are refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    const bad = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid-json');
    const huge = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: JSON.stringify({ action: 'x', pad: 'y'.repeat(20000) }) });
    assert.equal(huge.status, 400);
    assert.equal(huge.body.error, 'body-too-large');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported methods are refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const route = makeSkinRotationRoute(makeContext(root));
    const { status, body } = await call(route, { method: 'DELETE', headers: SAME_ORIGIN });
    assert.equal(status, 405);
    assert.equal(body.error, 'method-not-allowed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('weights and exclusions round-trip through the route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-mode', mode: 'weighted' } });
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-weight', id: 'alpha', weight: 5 } });
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-excluded', id: 'beta', excluded: true } });
    const { body } = await call(route, { method: 'GET', headers: SAME_ORIGIN });
    assert.equal(body.mode, 'weighted');
    assert.equal(body.skins.find((s) => s.id === 'alpha').weight, 5);
    assert.equal(body.skins.find((s) => s.id === 'beta').status, 'excluded');
    assert.equal(body.poolSize, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reset-defaults restores the shipped defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-mode', mode: 'weighted' } });
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-weight', id: 'alpha', weight: 9 } });
    const { body } = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'reset-defaults' } });
    assert.equal(body.changed, true);
    assert.equal(body.mode, 'random');
    assert.equal(body.recentRule, 'recent-2');
    assert.equal(body.skins.every((s) => s.weight === null), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent writes serialize to a consistent last-writer state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    await Promise.all([
      call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-enabled', enabled: false } }),
      call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-recent-rule', rule: 'recent-3' } }),
      call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-mode', mode: 'sequential' } }),
    ]);
    const { body } = await call(route, { method: 'GET', headers: SAME_ORIGIN });
    // The file is valid JSON and every field is one of the accepted values.
    assert.equal(typeof body.enabled, 'boolean');
    assert.ok(['random', 'sequential', 'weighted', 'fixed'].includes(body.mode));
    assert.ok(['disabled', 'recent-2', 'recent-3'].includes(body.recentRule));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('presets save the current controls, apply them back, and delete cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    // Configure something distinctive, then save it as a preset.
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-mode', mode: 'weighted' } });
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-weight', id: 'alpha', weight: 7 } });
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-excluded', id: 'beta', excluded: true } });
    const saved = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'save-preset', name: 'focus' } });
    assert.deepEqual(saved.body.presets, ['focus']);
    assert.equal(saved.body.preset, 'focus');

    // Drift away from the preset, then apply it again.
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-mode', mode: 'random' } });
    await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'set-excluded', id: 'beta', excluded: false } });
    const applied = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'use-preset', name: 'focus' } });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.mode, 'weighted');
    assert.equal(applied.body.skins.find((s) => s.id === 'alpha').weight, 7);
    assert.equal(applied.body.skins.find((s) => s.id === 'beta').status, 'excluded');

    // An unknown or malformed preset is refused without touching state.
    const missing = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'use-preset', name: 'ghost' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'unknown-preset');
    const badName = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'save-preset', name: '   ' } });
    assert.equal(badName.status, 400);
    assert.equal(badName.body.error, 'invalid-preset-name');

    const deleted = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'delete-preset', name: 'focus' } });
    assert.deepEqual(deleted.body.presets, []);
    assert.equal(deleted.body.preset, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a preset referencing an uninstalled skin never breaks the payload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-route-'));
  try {
    const context = makeContext(root);
    const route = makeSkinRotationRoute(context);
    // Hand-write a preset whose fixed skin does not exist, as an older profile might hold.
    const state = readState(context.profileDir);
    writeFileSync(
      join(context.profileDir, '.dsh-skin-rotation.json'),
      JSON.stringify({
        schemaVersion: 2,
        enabled: true,
        mode: 'fixed',
        fixedSkin: 'ghost',
        presets: { stale: { mode: 'fixed', fixedSkin: 'gone', exclude: ['also-gone'], weights: { gone: 3 }, recentRule: 'recent-3', order: ['gone'], historyLimit: 20 } },
        exclude: [],
        weights: {},
        recentRule: 'recent-2',
        order: [],
        sequentialIndex: 0,
        historyLimit: 100,
        recentHistory: [],
      }),
      'utf8',
    );
    void state;
    const { status, body } = await call(route, { method: 'GET', headers: SAME_ORIGIN });
    assert.equal(status, 200);
    assert.deepEqual(body.presets, ['stale']);
    const applied = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'use-preset', name: 'stale' } });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.fixedSkin, 'gone');
    // Rotation reports the missing fixed skin rather than silently switching.
    const rotated = await call(route, { method: 'POST', headers: SAME_ORIGIN, body: { action: 'rotate-now' } });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.changed, false);
    assert.equal(rotated.body.reason, 'fixed-not-installed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
