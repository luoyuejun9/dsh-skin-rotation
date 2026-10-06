/**
 * dsh-skin-rotation — browser half.
 *
 * Renders one card inside the 「皮肤」 settings page (the page the skin manager
 * registers as `settings.section` id `dsh-skins`) and drives the host route:
 * a switch that turns launch rotation on or off, a shuffle button, and the
 * live state of the catalog.
 *
 * The card is mounted into the manager's own page root (`[data-dsh-skin-manager]`)
 * as a trailing child, and re-attaches itself whenever that page opens, closes,
 * or re-renders. Nothing else in the page is touched, and every listener,
 * observer, timer and style tag is owned by this plugin's effect.
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

    var TEXT = {
      zh: {
        title: '皮肤轮换',
        intro: '每次启动 DeepSeek Harness 时，自动从已安装皮肤中随机选择一个。',
        switchLabel: '启动时随机轮换皮肤',
        on: '已开启',
        off: '已关闭',
        hintOn: '下次打开 DeepSeek Harness 时会随机换一个皮肤；手动切换皮肤仍然有效，直到下次启动。',
        hintOff: '已关闭：启动时保持当前皮肤不变，可在上方手动切换。',
        shuffle: '立即随机换一个',
        shuffling: '正在切换…',
        refresh: '重新读取',
        current: '当前皮肤',
        official: '官方默认',
        picked: '本次启动随机到',
        pool: (count) => `参与轮换 ${count} 个皮肤`,
        none: '还没有检测到已安装的皮肤（需要带 skin.json 的皮肤插件）。',
        blocked: '与当前 DSH 版本不兼容，已排除',
        loading: '正在读取状态…',
        failed: (message) => `无法读取皮肤轮换状态：${message}`,
        reloading: '已切换，正在刷新页面…',
        stateFile: '状态文件',
      },
      en: {
        title: 'Skin rotation',
        intro: 'Pick one installed skin at random every time DeepSeek Harness starts.',
        switchLabel: 'Rotate skins on launch',
        on: 'On',
        off: 'Off',
        hintOn: 'The next launch shows a different random skin. A manual switch still works until then.',
        hintOff: 'Off: the launch keeps the current skin. Switch manually above.',
        shuffle: 'Shuffle now',
        shuffling: 'Switching…',
        refresh: 'Refresh',
        current: 'Current skin',
        official: 'Official default',
        picked: 'Picked this launch',
        pool: (count) => `${count} skin(s) in the pool`,
        none: 'No installed skins found (a skin needs a skin.json manifest).',
        blocked: 'incompatible with this DSH version — excluded',
        loading: 'Reading state…',
        failed: (message) => `Cannot read skin rotation state: ${message}`,
        reloading: 'Switched — reloading the page…',
        stateFile: 'State file',
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
        '[' + CARD_ATTRIBUTE + '] ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 14px}',
        '[' + CARD_ATTRIBUTE + '] li{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,inherit)}',
        '[' + CARD_ATTRIBUTE + '] li[data-active="true"]{color:var(--dsw-alias-brand-primary,#4c7dff);font-weight:600}',
        '[' + CARD_ATTRIBUTE + '] .dsr-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}',
        '[' + CARD_ATTRIBUTE + '] .dsr-error{color:var(--dsw-alias-state-error-primary,#d94848)}',
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
        children.push(
          React.createElement('div', { key: 'switch', className: 'dsr-row' }, [
            React.createElement(
              'button',
              {
                key: 'toggle',
                type: 'button',
                className: 'dsr-switch',
                role: 'switch',
                'aria-checked': enabled ? 'true' : 'false',
                'aria-label': t.switchLabel,
                disabled: state.busy,
                onClick: function () {
                  props.onToggle(!enabled);
                },
              },
              [
                React.createElement('span', { key: 'track', className: 'dsr-track', 'data-on': enabled ? 'true' : 'false' }, [
                  React.createElement('span', { key: 'knob', className: 'dsr-knob' }),
                ]),
                React.createElement('span', { key: 'label' }, t.switchLabel),
                React.createElement('strong', { key: 'value' }, enabled ? t.on : t.off),
              ],
            ),
            React.createElement('span', { key: 'pool' }, t.pool(data.poolSize)),
          ]),
        );
        children.push(React.createElement('p', { key: 'hint' }, enabled ? t.hintOn : t.hintOff));

        var currentName = data.current === 'official'
          ? t.official
          : displayName(
            data.skins.filter(function (skin) { return skin.id === data.current; })[0] || { name: data.current, nameEn: null },
            language,
          );
        var picked = data.pickedThisBoot === null || data.pickedThisBoot === undefined
          ? null
          : data.skins.filter(function (skin) { return skin.id === data.pickedThisBoot; })[0] || null;
        var summary = t.current + '：' + currentName;
        if (picked !== null) summary += ' · ' + t.picked + '：' + displayName(picked, language);
        children.push(React.createElement('p', { key: 'summary' }, summary));

        if (data.skins.length === 0) {
          children.push(React.createElement('p', { key: 'none' }, t.none));
        } else {
          children.push(
            React.createElement(
              'ul',
              { key: 'list' },
              data.skins.map(function (skin) {
                return React.createElement(
                  'li',
                  { key: skin.id, 'data-active': skin.active ? 'true' : 'false' },
                  [
                    React.createElement('span', { key: 'dot', className: 'dsr-dot' }),
                    React.createElement('span', { key: 'name' }, displayName(skin, language)),
                    skin.admissible ? null : React.createElement('small', { key: 'blocked' }, '(' + t.blocked + ')'),
                  ],
                );
              }),
            ),
          );
        }

        children.push(
          React.createElement('div', { key: 'actions', className: 'dsr-actions' }, [
            React.createElement(
              'button',
              {
                key: 'shuffle',
                type: 'button',
                className: 'dsr-btn',
                disabled: state.busy || data.poolSize === 0,
                onClick: props.onShuffle,
              },
              state.busy ? t.shuffling : t.shuffle,
            ),
            React.createElement(
              'button',
              { key: 'refresh', type: 'button', className: 'dsr-btn', disabled: state.busy, onClick: props.onRefresh },
              t.refresh,
            ),
          ]),
        );
        children.push(React.createElement('code', { key: 'file' }, t.stateFile + '：' + data.stateFile));
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
            onShuffle: shuffle,
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

      function setEnabled(enabled) {
        state.busy = true;
        render();
        request({ action: 'set-enabled', enabled: enabled })
          .then(function (payload) {
            if (disposed) return;
            state.data = payload;
            state.error = null;
          })
          .catch(function (error) {
            state.error = error instanceof Error ? error.message : String(error);
          })
          .then(function () {
            state.busy = false;
            render();
          });
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
            window.setTimeout(function () {
              window.location.reload();
            }, 900);
          })
          .catch(function (error) {
            if (disposed) return;
            state.error = error instanceof Error ? error.message : String(error);
            state.busy = false;
            render();
          });
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
