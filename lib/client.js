/**
 * dsh-skin-rotation — browser half.
 *
 * Renders one card inside the 「皮肤」 settings page (the page the skin manager
 * registers as `settings.section` id `dsh-skins`) and drives the host route:
 * the rotation switch, the mode selector, the recent-repeat rule, per-skin
 * pool toggles and weights, "shuffle now" and "restore previous", and the
 * recent rotation history.
 *
 * The card is mounted into the manager's own page root (`[data-dsh-skin-manager]`)
 * as a trailing child, and re-attaches itself whenever that page opens, closes,
 * or re-renders. Nothing else in the page is touched, and every listener,
 * observer, timer and style tag is owned by this plugin's effect. The UI holds
 * no authority: it only forwards actions and re-reads the host state.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skin-rotation',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var ReactDOMClient = require('react-dom/client');

    var ROUTE = '/api/dsh/skin-rotation';
    var PAGE_SELECTOR = '[data-dsh-skin-manager]';
    var CARD_ATTRIBUTE = 'data-dsh-skin-rotation';
    var STYLE_ID = 'dsh-skin-rotation-style';
    var VERIFY_DELAY_MS = 2500;
    var VERIFY_RETRY_MS = 6000;

    var inject = [];

    var MODES = ['random', 'sequential', 'weighted', 'fixed'];
    var RECENT_RULES = ['disabled', 'recent-2', 'recent-3'];

    var TEXT = {
      zh: {
        title: '皮肤轮换',
        intro: '按你选的策略，在已安装皮肤之间自动切换；所有数据只存本地。',
        switchLabel: '启动时自动轮换',
        on: '已开启',
        off: '已关闭',
        hintOn: '下次启动按当前策略换皮肤；手动切换仍有效，直到下次启动。',
        hintOff: '已关闭：启动时保持当前皮肤不变。',
        shuffle: '立即换一个',
        shuffling: '正在切换…',
        restore: '恢复上一皮肤',
        restoring: '正在恢复…',
        refresh: '重新读取',
        modeLabel: '轮换模式',
        modes: { random: '随机', sequential: '顺序', weighted: '加权随机', fixed: '固定' },
        recentRuleLabel: '近期不重复',
        recentRules: { disabled: '不限制', 'recent-2': '避开最近 2 个', 'recent-3': '避开最近 3 个' },
        current: '当前皮肤',
        official: '官方默认',
        pool: (count) => `候选池 ${count} 个`,
        none: '还没有检测到已安装皮肤（需要带 skin.json 的皮肤插件）。',
        incompatible: '不兼容（已排除）',
        excluded: '已排除',
        inPool: '参与轮换',
        weight: '权重',
        lastUsed: '上次使用',
        history: '最近轮换',
        historyEmpty: '还没有轮换记录。',
        fixedSkinHint: '固定模式：始终使用指定皮肤，不自动切换。',
        modeFixed: '请选择一个固定皮肤',
        loading: '正在读取状态…',
        failed: (message) => `无法读取皮肤轮换状态：${message}`,
        unknown: '未知',
        triggers: { startup: '启动', manual: '手动', restore: '恢复', policy: '策略' },
        okResult: '成功',
        failResult: '失败',
        advanced: '高级设置',
        weightHint: '仅加权随机模式生效；留空用默认权重 1。',
        resetDefault: '恢复默认配置',
      },
      en: {
        title: 'Skin rotation',
        intro: 'Switch between installed skins on a schedule you choose; everything stays local.',
        switchLabel: 'Rotate on launch',
        on: 'On',
        off: 'Off',
        hintOn: 'The next launch rotates by the current policy. Manual switches still work until then.',
        hintOff: 'Off: launch keeps the current skin.',
        shuffle: 'Shuffle now',
        shuffling: 'Switching…',
        restore: 'Restore previous',
        restoring: 'Restoring…',
        refresh: 'Refresh',
        modeLabel: 'Mode',
        modes: { random: 'Random', sequential: 'Sequential', weighted: 'Weighted', fixed: 'Fixed' },
        recentRuleLabel: 'Avoid recent',
        recentRules: { disabled: 'No limit', 'recent-2': 'Skip last 2', 'recent-3': 'Skip last 3' },
        current: 'Current skin',
        official: 'Official default',
        pool: (count) => `${count} in pool`,
        none: 'No installed skins found (a skin needs a skin.json manifest).',
        incompatible: 'incompatible — excluded',
        excluded: 'excluded',
        inPool: 'in pool',
        weight: 'weight',
        lastUsed: 'last used',
        history: 'Recent rotations',
        historyEmpty: 'No rotations yet.',
        fixedSkinHint: 'Fixed mode: always use the chosen skin; no auto switch.',
        modeFixed: 'Pick a fixed skin',
        loading: 'Reading state…',
        failed: (message) => `Cannot read skin rotation state: ${message}`,
        unknown: 'unknown',
        triggers: { startup: 'startup', manual: 'manual', restore: 'restore', policy: 'policy' },
        okResult: 'ok',
        failResult: 'failed',
        advanced: 'Advanced',
        weightHint: 'Weighted mode only; empty uses the default weight of 1.',
        resetDefault: 'Reset to defaults',
      },
    };

    function copy() {
      var language = typeof navigator === 'object' && navigator !== null ? String(navigator.language || '') : '';
      return language.toLowerCase().startsWith('en') ? TEXT.en : TEXT.zh;
    }

    function css() {
      return [
        '[' + CARD_ATTRIBUTE + ']{margin-top:16px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));',
        'border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);',
        'display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5}',
        '[' + CARD_ATTRIBUTE + '] h3{margin:0;font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}',
        '[' + CARD_ATTRIBUTE + '] p{margin:0;color:var(--dsw-alias-label-secondary,inherit)}',
        '[' + CARD_ATTRIBUTE + '] .dsr-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
        '[' + CARD_ATTRIBUTE + '] .dsr-switch{display:inline-flex;align-items:center;gap:10px;cursor:pointer;background:none;border:0;padding:0;color:inherit;font:inherit}',
        '[' + CARD_ATTRIBUTE + '] .dsr-track{width:40px;height:22px;border-radius:999px;background:var(--dsw-alias-state-idle-primary,rgba(127,127,127,.45));',
        'position:relative;transition:background .16s ease;flex:0 0 auto}',
        '[' + CARD_ATTRIBUTE + '] .dsr-track[data-on="true"]{background:var(--dsw-alias-brand-primary,#4c7dff)}',
        '[' + CARD_ATTRIBUTE + '] .dsr-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .16s ease}',
        '[' + CARD_ATTRIBUTE + '] .dsr-track[data-on="true"] .dsr-knob{transform:translateX(18px)}',
        '[' + CARD_ATTRIBUTE + '] .dsr-actions{display:flex;gap:8px;flex-wrap:wrap}',
        '[' + CARD_ATTRIBUTE + '] button.dsr-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;',
        'color:inherit;border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer}',
        '[' + CARD_ATTRIBUTE + '] button.dsr-btn[disabled]{opacity:.5;cursor:default}',
        '[' + CARD_ATTRIBUTE + '] label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary,inherit)}',
        '[' + CARD_ATTRIBUTE + '] select,input[type="number"]{background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;',
        'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:6px;padding:4px 6px;font:inherit;max-width:160px}',
        '[' + CARD_ATTRIBUTE + '] ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
        '[' + CARD_ATTRIBUTE + '] li{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary,inherit);flex-wrap:wrap}',
        '[' + CARD_ATTRIBUTE + '] li[data-active="true"]{color:var(--dsw-alias-brand-primary,#4c7dff);font-weight:600}',
        '[' + CARD_ATTRIBUTE + '] .dsr-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}',
        '[' + CARD_ATTRIBUTE + '] .dsr-badge{font-size:11px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4))}',
        '[' + CARD_ATTRIBUTE + '] .dsr-error{color:var(--dsw-alias-state-error-primary,#d94848)}',
        '[' + CARD_ATTRIBUTE + '] .dsr-hist{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);display:flex;flex-direction:column;gap:2px}',
        '[' + CARD_ATTRIBUTE + '] code{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);word-break:break-all}',
      ].join('');
    }

    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return function () {};
      var tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = css();
      document.head.appendChild(tag);
      return function () {
        tag.remove();
      };
    }

    function displayName(skin, language) {
      if (language.startsWith('en') && skin.nameEn) return skin.nameEn;
      return skin.name;
    }

    function fmtTime(at) {
      if (at === null || at === undefined) return '';
      var d = new Date(at);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
    }

    function Card(props) {
      var state = props.state;
      var t = props.t;
      var language = props.language;
      var data = state.data;
      var children = [];

      React.useEffect(function () {
        props.onRendered();
      }, []);

      children.push(React.createElement('h3', { key: 'title' }, [
        React.createElement('span', { key: 'icon', 'aria-hidden': 'true' }, '🎲'),
        React.createElement('span', { key: 'text' }, t.title),
      ]));
      children.push(React.createElement('p', { key: 'intro' }, t.intro));

      if (state.error !== null) {
        children.push(React.createElement('p', { key: 'error', className: 'dsr-error' }, t.failed(state.error)));
      } else if (data === null) {
        children.push(React.createElement('p', { key: 'loading' }, t.loading));
      } else {
        var enabled = data.enabled === true;
        var mode = MODES.includes(data.mode) ? data.mode : 'random';
        var recentRule = RECENT_RULES.includes(data.recentRule) ? data.recentRule : 'recent-2';

        // --- overview row: switch + mode + recent rule --------------------
        children.push(
          React.createElement('div', { key: 'controls', className: 'dsr-row' }, [
            React.createElement(
              'button',
              {
                key: 'toggle', type: 'button', className: 'dsr-switch', role: 'switch',
                'aria-checked': enabled ? 'true' : 'false', 'aria-label': t.switchLabel,
                disabled: state.busy, onClick: function () { props.onToggle(!enabled); },
              },
              [
                React.createElement('span', { key: 'track', className: 'dsr-track', 'data-on': enabled ? 'true' : 'false' }, [
                  React.createElement('span', { key: 'knob', className: 'dsr-knob' }),
                ]),
                React.createElement('span', { key: 'label' }, t.switchLabel),
                React.createElement('strong', { key: 'value' }, enabled ? t.on : t.off),
              ],
            ),
            React.createElement('label', { key: 'mode' }, [
              React.createElement('span', null, t.modeLabel),
              React.createElement(
                'select',
                { value: mode, disabled: state.busy, onChange: function (event) { props.onMode(event.target.value); } },
                MODES.map(function (m) {
                  return React.createElement('option', { key: m, value: m }, t.modes[m]);
                }),
              ),
            ]),
            React.createElement('label', { key: 'recent' }, [
              React.createElement('span', null, t.recentRuleLabel),
              React.createElement(
                'select',
                { value: recentRule, disabled: state.busy, onChange: function (event) { props.onRecentRule(event.target.value); } },
                RECENT_RULES.map(function (r) {
                  return React.createElement('option', { key: r, value: r }, t.recentRules[r]);
                }),
              ),
            ]),
          ]),
        );
        children.push(React.createElement('p', { key: 'hint' }, enabled ? t.hintOn : t.hintOff));
        if (mode === 'fixed') {
          children.push(React.createElement('p', { key: 'fixedHint' }, t.fixedSkinHint));
        }

        // --- summary ------------------------------------------------------
        var currentName = data.current === 'official' || data.current === null || data.current === undefined
          ? t.official
          : displayName(data.skins.filter(function (s) { return s.id === data.current; })[0] || { name: data.current, nameEn: null }, language);
        children.push(React.createElement('p', { key: 'summary' }, [
          t.current + '：' + currentName,
          ' · ' + t.pool(data.poolSize),
        ].join('')));

        // --- skin list: pool toggle + status + weight ---------------------
        if (data.skins.length === 0) {
          children.push(React.createElement('p', { key: 'none' }, t.none));
        } else {
          children.push(
            React.createElement(
              'ul',
              { key: 'list' },
              data.skins.map(function (skin) {
                var inPool = skin.status === 'compatible';
                var badge = null;
                if (skin.status === 'incompatible') badge = React.createElement('span', { key: 'badge', className: 'dsr-badge' }, t.incompatible);
                else if (skin.status === 'excluded') badge = React.createElement('span', { key: 'badge', className: 'dsr-badge' }, t.excluded);
                var weight = mode === 'weighted'
                  ? React.createElement('input', {
                    key: 'weight', type: 'number', min: '0', step: '1',
                    value: skin.weight === null || skin.weight === undefined ? '' : String(skin.weight),
                    disabled: state.busy,
                    title: t.weightHint,
                    onChange: function (event) { props.onSetWeight(skin.id, event.target.value); },
                  })
                  : null;
                return React.createElement(
                  'li',
                  { key: skin.id, 'data-active': skin.active ? 'true' : 'false' },
                  [
                    React.createElement('input', {
                      key: 'toggle', type: 'checkbox',
                      checked: inPool, disabled: state.busy || skin.status === 'incompatible',
                      onChange: function (event) { props.onToggleSkin(skin.id, event.target.checked); },
                      title: t.inPool,
                    }),
                    React.createElement('span', { key: 'dot', className: 'dsr-dot' }),
                    React.createElement('span', { key: 'name' }, displayName(skin, language)),
                    skin.active ? React.createElement('span', { key: 'cur', className: 'dsr-badge' }, t.current) : null,
                    badge,
                    weight,
                    skin.lastUsedAt ? React.createElement('small', { key: 'used' }, t.lastUsed + ' ' + fmtTime(skin.lastUsedAt)) : null,
                  ],
                );
              }),
            ),
          );
        }

        // --- actions ------------------------------------------------------
        children.push(
          React.createElement('div', { key: 'actions', className: 'dsr-actions' }, [
            React.createElement('button', { key: 'shuffle', type: 'button', className: 'dsr-btn', disabled: state.busy || data.poolSize === 0, onClick: props.onShuffle }, state.busy ? t.shuffling : t.shuffle),
            React.createElement('button', { key: 'restore', type: 'button', className: 'dsr-btn', disabled: state.busy, onClick: props.onRestore }, t.restore),
            React.createElement('button', { key: 'refresh', type: 'button', className: 'dsr-btn', disabled: state.busy, onClick: props.onRefresh }, t.refresh),
          ]),
        );

        // --- history ------------------------------------------------------
        children.push(React.createElement('p', { key: 'histTitle' }, t.history));
        var hist = data.history || [];
        if (hist.length === 0) {
          children.push(React.createElement('p', { key: 'histEmpty', className: 'dsr-hist' }, t.historyEmpty));
        } else {
          children.push(
            React.createElement(
              'div',
              { key: 'hist', className: 'dsr-hist' },
              hist.map(function (record, index) {
                var fromName = record.from === 'official' || record.from === null ? t.official : record.from;
                var toName = record.to === null ? t.unknown : record.to;
                return React.createElement('div', { key: index }, [
                  fmtTime(record.at) + ' · ' + (t.triggers[record.trigger] || record.trigger),
                  ' · ' + fromName + ' → ' + toName,
                  ' · ' + (record.ok ? t.okResult : t.failResult),
                ].join(''));
              }),
            ),
          );
        }

        // --- advanced (collapsed) ----------------------------------------
        children.push(
          React.createElement('details', { key: 'advanced' }, [
            React.createElement('summary', null, t.advanced),
            React.createElement('p', { key: 'weightHint' }, t.weightHint),
            React.createElement('button', { key: 'reset', type: 'button', className: 'dsr-btn', disabled: state.busy, onClick: props.onReset }, t.resetDefault),
          ]),
        );
      }

      return React.createElement('div', { className: 'dsr-card' }, children);
    }

    /**
     * Mount the card inside the skin manager's settings page.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      var t = copy();
      var language = typeof navigator === 'object' && navigator !== null ? String(navigator.language || '').toLowerCase() : '';
      var container = document.createElement('div');
      container.setAttribute(CARD_ATTRIBUTE, '');
      var host = null;
      var reactRoot = null;
      var state = { data: null, error: null, busy: false };
      var disposed = false;
      var reported = false;
      var timers = [];

      function render() {
        if (reactRoot === null || disposed) return;
        reactRoot.render(
          React.createElement(Card, {
            state: state,
            t: t,
            language: language,
            onToggle: setEnabled,
            onMode: function (mode) { void send({ action: 'set-mode', mode: mode }); },
            onRecentRule: function (rule) { void send({ action: 'set-recent-rule', rule: rule }); },
            onToggleSkin: function (id, excluded) { void send({ action: 'set-excluded', id: id, excluded: !excluded }); },
            onSetWeight: function (id, value) { void send({ action: 'set-weight', id: id, weight: value === '' ? null : Number(value) }); },
            onShuffle: shuffle,
            onRestore: restore,
            onReset: reset,
            onRefresh: function () { void load(); },
            onRendered: function () { report(true, true, true); },
          }),
        );
      }

      function request(body) {
        return fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (response) {
          return response.json().then(function (payload) {
            if (!response.ok || payload.ok !== true) throw new Error(payload.error || 'HTTP ' + response.status);
            return payload;
          });
        });
      }

      function load() {
        return fetch(ROUTE, { method: 'GET', credentials: 'same-origin' })
          .then(function (response) {
            return response.json().then(function (payload) {
              if (!response.ok || payload.ok !== true) throw new Error(payload.error || 'HTTP ' + response.status);
              return payload;
            });
          })
          .then(function (payload) {
            if (disposed) return;
            state.data = payload;
            state.error = null;
            render();
            scheduleVerify(payload);
          })
          .catch(function (error) {
            if (disposed) return;
            state.error = error instanceof Error ? error.message : String(error);
            render();
          });
      }

      function send(body) {
        state.busy = true;
        render();
        return request(body)
          .then(function (payload) {
            if (disposed) return;
            state.data = payload;
            state.error = null;
          })
          .catch(function (error) {
            if (disposed) return;
            state.error = error instanceof Error ? error.message : String(error);
          })
          .then(function () {
            state.busy = false;
            render();
          });
      }

      function setEnabled(enabled) {
        void send({ action: 'set-enabled', enabled: enabled });
      }

      function shuffle() {
        state.busy = true;
        render();
        request({ action: 'rotate-now' })
          .then(function (payload) {
            if (disposed) return;
            state.data = payload;
            state.error = null;
            render();
            window.setTimeout(function () { window.location.reload(); }, 900);
          })
          .catch(function (error) {
            if (disposed) return;
            state.error = error instanceof Error ? error.message : String(error);
            state.busy = false;
            render();
          });
      }

      function restore() {
        state.busy = true;
        render();
        request({ action: 'restore-previous' })
          .then(function (payload) {
            if (disposed) return;
            state.data = payload;
            state.error = null;
            render();
            window.setTimeout(function () { window.location.reload(); }, 900);
          })
          .catch(function (error) {
            if (disposed) return;
            state.error = error instanceof Error ? error.message : String(error);
            state.busy = false;
            render();
          });
      }

      function reset() {
        void send({ action: 'reset-defaults' });
      }

      /**
       * Safety net: if the patch layer already names this launch's pick but the
       * page is not wearing it, the host tree never recomposed — reload once.
       * A manual switch made after boot moves `current` away from the pick and
       * is therefore never "fixed" here.
       */
      function scheduleVerify(payload) {
        if (!payload || payload.enabled !== true) return;
        if (payload.pickedThisBoot === null || payload.pickedBodyAttr === null) return;
        if (payload.current !== payload.pickedThisBoot) return;
        var key = 'dsh-skin-rotation:verify:' + payload.bootId;
        var check = function () {
          if (disposed) return;
          if (document.body === null || document.body.hasAttribute(payload.pickedBodyAttr)) return;
          try {
            if (window.sessionStorage.getItem(key) === '1') return;
            window.sessionStorage.setItem(key, '1');
          } catch {
            return;
          }
          window.location.reload();
        };
        timers.push(window.setTimeout(check, VERIFY_DELAY_MS));
        timers.push(window.setTimeout(check, VERIFY_RETRY_MS));
      }

      /** Tell the host whether the card found its page and actually rendered. */
      function report(mounted, found, rendered) {
        if (!mounted && reported) return;
        reported = true;
        request({ action: 'client-report', mounted: mounted, found: found, rendered: rendered === true }).catch(function () {
          if (!mounted) reported = false;
        });
      }

      /** Keep the card attached to whichever skin page is mounted right now. */
      function attach() {
        if (disposed) return;
        var page = document.querySelector(PAGE_SELECTOR);
        if (page === null) {
          host = null;
          if (container.parentNode !== null) container.remove();
          return;
        }
        if (host === page && container.parentNode === page) return;
        host = page;
        page.appendChild(container);
        if (reactRoot === null) {
          reactRoot = ReactDOMClient.createRoot(container);
          render();
        }
        void load();
        report(true, true);
      }

      var scheduled = false;
      var observer = new MutationObserver(function () {
        if (scheduled) return;
        scheduled = true;
        window.requestAnimationFrame(function () {
          scheduled = false;
          attach();
        });
      });

      ctx.effect(function () {
        return installStyles();
      }, 'dsh-skin-rotation: card styles');

      ctx.effect(function () {
        observer.observe(document.body, { childList: true, subtree: true });
        attach();
        timers.push(
          window.setTimeout(function () {
            report(container.parentNode !== null, host !== null);
          }, 5000),
        );
        return function () {
          disposed = true;
          observer.disconnect();
          for (var timer of timers.splice(0)) window.clearTimeout(timer);
          if (reactRoot !== null) reactRoot.unmount();
          reactRoot = null;
          container.remove();
        };
      }, 'dsh-skin-rotation: settings card');
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Test-only handles: the pure render path, exercised without a DOM. */
    exports.__internals = { Card: Card, css: css, TEXT: TEXT };
    return module.exports;
  },
});
