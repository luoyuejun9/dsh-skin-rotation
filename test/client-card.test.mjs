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
    pickedThisBoot: 'orca-link',
    lastPicked: 'orca-link',
    lastRotatedAt: 1,
    current: 'orca-link',
    currentBodyAttr: 'data-dsh-orca-link',
    pickedBodyAttr: 'data-dsh-orca-link',
    catalogSize: 2,
    poolSize: 2,
    route: '/api/dsh/skin-rotation',
    stateFile: '/tmp/profile/.dsh-skin-rotation.json',
    lastClientReport: null,
    skins: [
      { id: 'orca-link', name: '虎鲸链路', nameEn: 'ORCA LINK', bodyAttr: 'data-dsh-orca-link', package: 'pkg-orca', active: true, admissible: true, incompatible: null },
      { id: 'maid-atelier', name: '深海女仆工坊', nameEn: 'Abyssal Maid Atelier', bodyAttr: 'data-dsh-maid-atelier', package: 'pkg-maid', active: false, admissible: false, incompatible: { runtimeVersion: '0.2.0-rc.2', peers: { x: '1' } } },
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

test('card renders the switch, the actions and the skin list', async () => {
  const { exports } = await loadClient();
  const rendered = exports.__internals.Card({
    state: { data: payload(), error: null, busy: false },
    t: exports.__internals.TEXT.zh,
    language: 'zh-cn',
    onToggle() {},
    onShuffle() {},
    onRefresh() {},
    onRendered() {},
  });
  const elements = flatten(rendered);
  const byRole = elements.filter((element) => element.props.role === 'switch');
  assert.equal(byRole.length, 1);
  assert.equal(byRole[0].props['aria-checked'], 'true');
  const buttons = elements.filter((element) => element.type === 'button');
  assert.equal(buttons.length, 3);
  const list = elements.filter((element) => element.type === 'li');
  assert.equal(list.length, 2);
  assert.equal(list[0].props['data-active'], 'true');
  assert.equal(list[1].props['data-active'], 'false');
  const text = JSON.stringify(elements.map((element) => element.children));
  assert.match(text, /深海女仆工坊/);
  assert.match(text, /不兼容/);
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
