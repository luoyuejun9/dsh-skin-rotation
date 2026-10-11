/**
 * Browser-half tests for the pure render path.
 *
 * `lib/client.js` is a browser bundle: it registers a factory on
 * `window.__ModuleLoader__` and never touches the DOM at module scope. Loading
 * it in Node with a stub loader and a stub React therefore exercises the whole
 * card render tree — the part most likely to break — without a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/** Load the browser bundle and return its realized module exports. */
let loadCount = 0;
async function loadClient() {
  let definition;
  const calls = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  // A fresh query keeps Node's ES module cache from skipping the bundle body.
  loadCount += 1;
  await import(`${new URL('../lib/client.js', import.meta.url).href}?test=${loadCount}`);
  assert.equal(definition.id, 'dsh-skin-rotation');
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useEffect(callback) {
      calls.push(callback);
    },
  };
  const exports = definition.factory((request) => {
    if (request === 'react') return React;
    if (request === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    throw new Error(`unexpected request: ${request}`);
  });
  return { exports, effectCalls: calls };
}

/** A payload shaped exactly like the host route's GET response. */
function payload(overrides = {}) {
  return {
    ok: true,
    enabled: true,
    bootId: 'boot-1',
    mode: 'random',
    recentRule: 'recent-2',
    pickedThisBoot: 'orca-link',
    lastPicked: 'orca-link',
    lastRotatedAt: 1,
    current: 'orca-link',
    currentBodyAttr: 'data-dsh-orca-link',
    pickedBodyAttr: 'data-dsh-orca-link',
    catalogSize: 2,
    poolSize: 2,
    fixedSkin: null,
    sequentialIndex: 0,
    lastClientReport: null,
    history: [
      { at: '2026-10-11T09:00:00.000Z', from: 'official', to: 'orca-link', trigger: 'startup', mode: 'random', ok: true, reason: null },
      { at: '2026-10-11T08:00:00.000Z', from: 'orca-link', to: null, trigger: 'manual', mode: 'random', ok: false, reason: 'empty-pool' },
    ],
    skins: [
      { id: 'orca-link', name: '虎鲸链路', nameEn: 'ORCA LINK', bodyAttr: 'data-dsh-orca-link', active: true, inPool: true, status: 'compatible', reason: null, weight: 3, lastUsedAt: '2026-10-11T09:00:00.000Z' },
      { id: 'maid-atelier', name: '深海女仆工坊', nameEn: 'Abyssal Maid Atelier', bodyAttr: 'data-dsh-maid-atelier', active: false, inPool: false, status: 'excluded', reason: 'excluded-by-user', weight: null, lastUsedAt: null },
      { id: 'deny-skin', name: '不兼容皮肤', nameEn: 'Denied', bodyAttr: 'data-deny', active: false, inPool: false, status: 'incompatible', reason: 'incompatible', weight: null, lastUsedAt: null },
    ],
    ...overrides,
  };
}

/** Walk a rendered element tree and collect every element. */
function flatten(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  out.push(node);
  flatten(node.children, out);
  return out;
}

test('client bundle registers an apply/inject plugin', async () => {
  const { exports } = await loadClient();
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, []);
  assert.equal(typeof exports.__internals.Card, 'function');
});

test('card renders the switch, the mode selector, the pool rows and the history', async () => {
  const { exports } = await loadClient();
  const handlers = {
    onToggle() {}, onShuffle() {}, onRestore() {}, onRefresh() {}, onRendered() {},
    onMode() {}, onRecentRule() {}, onToggleSkin() {}, onSetWeight() {}, onReset() {},
  };
  const rendered = exports.__internals.Card({
    state: { data: payload(), error: null, busy: false },
    t: exports.__internals.TEXT.zh,
    language: 'zh-cn',
    ...handlers,
  });
  const elements = flatten(rendered);
  const byRole = elements.filter((element) => element.props.role === 'switch');
  assert.equal(byRole.length, 1);
  assert.equal(byRole[0].props['aria-checked'], 'true');

  // Two selects: rotation mode and recent-repeat rule.
  const selects = elements.filter((element) => element.type === 'select');
  assert.equal(selects.length, 2);
  const optionValues = (select) => flatten(select.children).filter((e) => e.type === 'option').map((e) => e.props.value);
  assert.deepEqual(optionValues(selects[0]), ['random', 'sequential', 'weighted', 'fixed']);
  assert.deepEqual(optionValues(selects[1]), ['disabled', 'recent-2', 'recent-3']);

  // One checkbox per skin: pool membership, incompatible disabled.
  const checkboxes = elements.filter((element) => element.type === 'input' && element.props.type === 'checkbox');
  assert.equal(checkboxes.length, 3);
  assert.equal(checkboxes[0].props.checked, true);
  assert.equal(checkboxes[1].props.checked, false);
  assert.equal(checkboxes[2].props.disabled, true);

  // Five buttons: the on/off switch, shuffle, restore, refresh, reset.
  const buttons = elements.filter((element) => element.type === 'button');
  assert.equal(buttons.length, 5);

  const list = elements.filter((element) => element.type === 'li');
  assert.equal(list.length, 3);
  assert.equal(list[0].props['data-active'], 'true');
  assert.equal(list[1].props['data-active'], 'false');

  const text = JSON.stringify(elements.map((element) => element.children));
  assert.match(text, /深海女仆工坊/);
  assert.match(text, /不兼容/);
  assert.match(text, /最近轮换/);
});

test('card renders every degenerate state without throwing', async () => {
  const { exports } = await loadClient();
  const t = exports.__internals.TEXT.zh;
  const states = [
    { data: null, error: null, busy: false },
    { data: null, error: 'boom', busy: false },
    { data: payload({ enabled: false, pickedThisBoot: null, pickedBodyAttr: null, current: 'official', catalogSize: 0, poolSize: 0, skins: [] }), error: null, busy: false },
    { data: payload({ skins: [], poolSize: 0, current: 'official' }), error: null, busy: true },
    { data: payload({ pickedThisBoot: 'ghost', current: 'ghost', skins: [] }), error: null, busy: false },
  ];
  for (const state of states) {
    const rendered = exports.__internals.Card({
      state,
      t,
      language: 'en-us',
      onToggle() {},
      onShuffle() {},
      onRefresh() {},
      onRendered() {},
    });
    assert.ok(flatten(rendered).length > 0);
  }
  const english = exports.__internals.Card({
    state: { data: payload(), error: null, busy: false },
    t: exports.__internals.TEXT.en,
    language: 'en-us',
    onToggle() {},
    onShuffle() {},
    onRefresh() {},
    onRendered() {},
  });
  assert.match(JSON.stringify(flatten(english).map((element) => element.children)), /ORCA LINK/);
});

test('the switch asks for the inverted value and the shuffle fires once per click', async () => {
  const { exports } = await loadClient();
  const toggles = [];
  const shuffles = [];
  const rendered = exports.__internals.Card({
    state: { data: payload(), error: null, busy: false },
    t: exports.__internals.TEXT.zh,
    language: 'zh-cn',
    onToggle: (value) => toggles.push(value),
    onShuffle: () => shuffles.push(1),
    onRefresh() {},
    onRendered() {},
  });
  const elements = flatten(rendered);
  elements.find((element) => element.props.role === 'switch').props.onClick();
  assert.deepEqual(toggles, [false]);
  elements.find((element) => element.props.className === 'dsr-btn' && element.props.disabled === false).props.onClick();
  assert.equal(shuffles.length, 1);
});

test('the rendered card reports through the mount effect', async () => {
  const { exports, effectCalls } = await loadClient();
  let rendered = 0;
  exports.__internals.Card({
    state: { data: payload(), error: null, busy: false },
    t: exports.__internals.TEXT.zh,
    language: 'zh-cn',
    onToggle() {},
    onShuffle() {},
    onRefresh() {},
    onRendered: () => {
      rendered += 1;
    },
  });
  assert.equal(effectCalls.length, 1);
  effectCalls[0]();
  assert.equal(rendered, 1);
});

test('the stylesheet is scoped to the card attribute', async () => {
  const { exports } = await loadClient();
  const css = exports.__internals.css();
  assert.match(css, /\[data-dsh-skin-rotation\]/);
  assert.match(css, /--dsw-alias-label-primary/);
  assert.equal(css.includes('body{'), false);
});

test('the module path is stable', () => {
  assert.match(fileURLToPath(new URL('../lib/client.js', import.meta.url)), /lib\/client\.js$/);
});
