<p align="center">
  <strong>dsh-skin-rotation</strong><br/>
  <em>每次启动换一个皮肤 —— DeepSeek Harness 皮肤轮换，开关就放在「设置 → 皮肤」里。</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
  <a href="https://www.dsh.so/artifact/dsh-skin-rotation/"><img src="https://www.dsh.so/badge/dsh-skin-rotation.svg" alt="dsh.so 安全评级：低风险"></a>
  <a href="https://github.com/luoyuejun9/dsh-skin-rotation/actions/workflows/test.yml"><img src="https://github.com/luoyuejun9/dsh-skin-rotation/actions/workflows/test.yml/badge.svg" alt="test"></a>
  <a href="https://www.npmjs.com/package/dsh-skin-rotation"><img src="https://img.shields.io/npm/v/dsh-skin-rotation" alt="npm"></a>
  <a href="https://github.com/luoyuejun9/dsh-skin-rotation/stargazers"><img src="https://img.shields.io/github/stars/luoyuejun9/dsh-skin-rotation?style=flat" alt="stars"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-8257D0" alt="dsh-plugin"></a>
</p>

<p align="center"><a href="README.md">English</a> | 中文</p>

---

## 它做什么

你装了四个皮肤，四个都喜欢，但每次只用其中一个。

`dsh-skin-rotation` 会在每次 DeepSeek Harness 启动时随机挑一个启用，并在「设置 → 皮肤」页里放一个开关随时关掉。它不会连续两次挑到同一个皮肤，只挑宿主真正能加载的皮肤，其余一概不碰。

```
第 1 次启动 → 深海女仆工坊      第 2 次启动 → 虎鲸链路      第 3 次启动 → 鲸鱼娘昼夜工坊
```

## 安装

从 GitHub 一行装：

```sh
dsh plugin --profile web add github:luoyuejun9/dsh-skin-rotation
```

从 npm 装：

```sh
dsh plugin --profile web add dsh-skin-rotation
```

或者用 [最新 Release](https://github.com/luoyuejun9/dsh-skin-rotation/releases/latest) 上的预构建 tarball——不需要构建，也不会触发 `allowBuilds` 授权：

```sh
dsh plugin --profile web add https://github.com/luoyuejun9/dsh-skin-rotation/releases/latest/download/dsh-skin-rotation.tgz
```

重启一次，然后打开「设置 → 皮肤」，轮换卡片就在这个页面底部。

> 装进桌面端而不是 web profile？把 `--profile web` 换成 `--profile desktop` 即可，两边都能用。

## 开关长什么样

```
设置 → 皮肤
├── 已安装皮肤                 ← 皮肤管理器自己的页面
│   ├── 官方默认
│   ├── 深海女仆工坊  …
│   └── …
└── 🎲 皮肤轮换                ← 本插件
    ├── [开关] 启动时随机轮换皮肤        参与轮换 4 个皮肤
    ├── 当前皮肤：虎鲸链路 · 本次启动随机到：虎鲸链路
    ├── 深海女仆工坊   虎鲸链路   鲸鱼娘昼夜工坊   DeepSeek 云鲸纸面
    └── [立即随机换一个]  [重新读取]
```

| 控件 | 作用 |
| --- | --- |
| **启动时随机轮换皮肤** | 开启：每次启动随机换一个。关闭：启动时保持当前皮肤不变。 |
| **立即随机换一个** | 马上抽一次并刷新页面；开关关着也能用。 |
| **皮肤列表** | 谁在轮换池里；宿主不会加载的皮肤会被标注并排除。 |

在皮肤管理器里手动切换照旧有效——直到下次启动，这正是这个插件的意义。

## 工作原理

```mermaid
flowchart LR
  A[宿主启动] --> B{轮换开启?}
  B -- 否 --> Z[保持当前皮肤]
  B -- 是 --> C[发现已安装皮肤]
  C --> D[排除宿主会拒绝的皮肤]
  D --> E[随机抽一个，且不与上次相同]
  E --> F[改写 profile patch + home patch 里的<br/>dsh-skin managed 区段]
  F --> G[DSH 的 HMR 监听器重新组合插件树]
  G --> H[页面打开时已经是抽中的皮肤]
```

- **轮换是宿主侧的决定，一次启动只做一次。** 进程级 boot key 保证插件被热重载时不会重复抽签，真正重启才会重抽；浏览器刷新不会重掷骰子。
- **它改的是补丁层，不是皮肤。** 插件改写的是皮肤管理器自己也在用的那段 `# --- dsh-skin managed ---` 互斥区段，profile patch 与优先级更高的 home patch 一起改。区段之外的一切——手写行、注释、DSH 自己追加的设置行——原样保留，写入走临时文件 + rename 的原子替换。
- **只抽宿主真能加载的皮肤。** DSH 会拒绝那些 `@deepseek-ai/dsh*` peer 范围不含当前运行时的插件行：补丁里写着 `disabled: false`，行却根本不会启动，结果是一个皮肤都没有。本插件用自己的语义化版本求值器复刻了这道准入判定，并读取 profile 的 `compatibility.json` 放行记录，因此随机结果不会落到死皮肤上。
- **浏览器半区只有一张卡片。** 它监听 DOM，往皮肤管理器页面根节点追加一个容器，把卡片渲染进去；不注册自己的设置页、不留全局状态，卸载时清掉自己创建的 observer、定时器和样式。
- **不碰皮肤文件、`skin.json`，也不接管管理器自己的状态。**

### 写入的文件

| 路径 | 内容 |
| --- | --- |
| `<profile>/cordis.patch.yml` | 共用 `dsh-skin managed` 互斥区段 |
| `<DSH_HOME>/cordis.patch.yml` | 同一区段——优先级更高，必须一起改 |
| `<profile>/.dsh-skin-rotation.json` | 本插件自己的偏好：开关、上次抽中的皮肤、启动标识、客户端回报 |

HTTP 接口：`GET/POST /api/dsh/skin-rotation`，仅同源，跨站请求直接拒绝。

## 环境要求

- DeepSeek Harness web profile，`>=0.2.0-rc.2 <0.3.0-0`（声明在 `engines.dsh`）。
- 至少装两个皮肤轮换才有意义。皮肤的判定沿用生态约定：包内带合法 `skin.json`（`id`、`package`、`bodyAttr`、`wiring.id`）。
- 卡片挂在[皮肤管理器](https://github.com/Small-tailqwq/dsh-deep-whale)的皮肤页（`settings.section` id `dsh-skins`）里；没有管理器时轮换依然工作，只是改用路由开关。
- 不依赖任何 `@deepseek-ai/*` 运行时包：无需解析、无需构建、安装时不执行任何脚本。
- 已被 [dsh.so](https://www.dsh.so/artifact/dsh-skin-rotation/) 独立收录：安全审计通过（低风险），安装验证 `L5`（已在 dsh `0.2.0-rc.2` 上实机跑通）。

## 开发

```sh
node --test                       # 29 个用例
npm pack --pack-destination dist  # 打包发布用的 tarball
```

| 测试 | 覆盖内容 |
| --- | --- |
| `test/host.test.mjs` | 区段改写（含区段外记录保留）、真实 profile 的发现、随机规则、启动一次性、双层写入与回滚、路由防护 |
| `test/client-card.test.mjs` | 整棵卡片渲染树，通过桩模块加载器 + 桩 React 驱动，不需要浏览器 |
| `test/semver-oracle.test.mjs` | 与真实 node-semver 的差分验证，覆盖生成的组合矩阵（本机没装时自动跳过） |
| `tools/e2e-rotation.sh` | 在独立 `DSH_HOME` 下真实启动宿主多次，断言抽中的皮肤就是浏览器实际拿到的那个 |

端到端脚本是里面最有意思的一个：它不验证插件「自认为」做了什么，而是去取浏览器实际收到的 boot graph，确认里面只有一个皮肤模块。

## FAQ

**会和皮肤管理器打架吗？** 不会。两边用同一套规则写同一段区段；本插件只在启动时轮换，之后完全不插手。

**浏览器刷新会重抽吗？** 不会——每个宿主进程只抽一次，否则每次刷新都换皮肤。

**只装了一个皮肤呢？** 轮换等于不换，区段照样会被规范化。

**能一直用我现在这个皮肤吗？** 关掉开关即可，启动不再改动皮肤，手动切换也不受影响。

## License

MIT © luoyuejun9
