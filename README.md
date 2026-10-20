# dsh-browser-bridge

把 `browser-cdp-control` 这个 Markdown skill 升级成 **DeepSeek Harness 一等插件**。

skill 版本的问题：每次用到都要先 `skill` 加载一遍文档、agent 自己拼 Python 片段、自己判断要不要起 master、自己记得「tabId 要 int」「HttpOnly 要用 Network.getCookies」「Promise 要 awaitPromise」这些坑——全靠模型读文档自觉。
插件版本把这些**变成工具签名和执行语义**：参数由 DSH 的 `defineTool` 校验，轮询、打码、截断、自启 master 都是确定性的代码。

## 它提供什么

| 工具 | 作用 | 对应 skill 里的哪段 |
|---|---|---|
| `browser_tabs` | 列已连接的标签页会话（tabId / url / title / type），可按 URL 子串过滤 | 「Python 调用模板」+ `{"cmd":"tabs"}` |
| `browser_eval` | 在真实标签页里跑 JS，同步值 / Promise 都能取 | 「1) 异步 fetch / Promise 结果」 |
| `browser_cookie` | 全量 cookie（**含 HttpOnly**）+ 可选 localStorage | 「2) 全量 Cookie + token」 |
| `browser_navigate` | 导航（单独一次调用，避免 `Inspected target navigated or closed`） | 「坑 5」 |
| `browser_install` | 拉起 / 检查 TMWebDriver master | 「启动 master（必须 keep-alive）」 |

外加一个定时：`browser_tabs` 成功后会缓存会话列表，`defaultTabSearch` 命中的会话可以当默认 tab。

## 0.2.0：纯 JS，不再需要 python

**这是重点变化。** 之前的版本要 spawn 一个 Python 的 `TMWebDriver` master，于是带进来：
python 解释器、PATH、GenericAgent 目录、`simple_websocket_server` + `bottle` 两个 pip 包，
以及 Windows 上一串 `ENOENT`（见文末 0.1.1 记录）。

Python master 其实只做一件事：收扩展的会话、把命令转给扩展、等结果回来。没有任何
非 JS 不可的能力。所以 0.2.0 直接把这层用 Node 重写了（`src/js-master.js`，约 250 行）：

```
浏览器扩展 tmwd_cdp_bridge  ──ws://127.0.0.1:18765──▶  插件内建 JS master
                                                            │
                                                     五个 browser_* 工具
```

扩展侧**完全不用改**，它本来就是「连 18765 的客户端」，谁在这个端口上听它就信谁。
停掉旧的 Python master 后，扩展会在 5 秒内自己重连到 JS master（实测 40+ 个标签页全量恢复）。

复刻的协议（与 `tmwd_cdp_bridge/background.js` 逐条对齐）：
`ext_ready` / `tabs_update` / `ack` / `result` / `error` / `ping`。

运行时依赖只剩 `ws`（纯 JS，`bufferutil`/`utf-8-validate` 都是可选加速，不需要编译）。

### 两种模式

| mode | 说明 | 需要 python |
|---|---|---|
| `self`（默认） | 插件进程内起 JS master，监听 18765 | 不需要 |
| `external` | 连已有 Python master 的 HTTP `/link`（兼容旧部署） | 需要 |

## 安装

仓库：<https://github.com/Somet2mes/dsh-browser-bridge>

在目标机器上（`desktop` 或 `web` profile），改 profile 的 `package.json`：

```bash
cd "$HOME/.dsh/profiles/desktop"   # Windows: %USERPROFILE%\.dsh\profiles\desktop
```

在 `dependencies` 里加：

```json
"dsh-browser-bridge": "https://github.com/Somet2mes/dsh-browser-bridge/archive/refs/heads/main.tar.gz"
```

在 `dsh.profile.bundles` 里追加：

```json
"dsh-browser-bridge"
```

然后：

```bash
pnpm install
# 重启 DSH
```

也可以用 GUI：设置 → 插件 → 安装，粘
`https://github.com/Somet2mes/dsh-browser-bridge/archive/refs/heads/main.tar.gz`。

**两个地方都要写**：`dependencies` 决定插件管理面板能不能看到它，
`bundles` 决定 loader 会不会把它当 bundle 层加载。

固定版本就把 URL 换成 tag：
`https://github.com/Somet2mes/dsh-browser-bridge/archive/refs/tags/v0.2.0.tar.gz`

## 装浏览器扩展（必须）

插件不带浏览器 —— 它需要一个**已登录你会话的** Edge/Chrome 里的扩展把标签页能力桥出来。
扩展就在本仓库的 [`extension/`](extension/) 目录，安装细节见 [extension/README.md](extension/README.md)。

三步：

1. 找到 `extension/` 目录
   - 已装插件包：`<profile>/node_modules/dsh-browser-bridge/extension`
   - 或 `git clone https://github.com/Somet2mes/dsh-browser-bridge.git`

2. 浏览器地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`）
   → 打开「开发人员模式」→「加载解压缩的扩展」→ 选中 `extension` 目录

3. 打开任意网页，右下角出现 `ljq_driver: 已连接` 就成了

扩展连的是 `ws://127.0.0.1:18765`，会每 5 秒重试一次。
所以**先开浏览器还是先开 DSH 都行**，插件起来后 5 秒内自动连上。

> 扩展申请了 `debugger` 等权限，等价于「完全控制这个浏览器」。
> 建议用专用 profile 登录目标站点，别装在日常账号的 profile 上。

## 配置项

```yaml
- id: browser-bridge
  name: 'dsh-browser-bridge'
  config:
    enabled: true
    host: 127.0.0.1
    mode: self             # self = 内建 JS master（默认）| external = 连 Python master
    wsPort: 18765          # self 模式监听端口（扩展写死连它）
    port: 18766            # external 模式：Python master 的 HTTP 端口
    defaultTabSearch: ''   # 默认 tab：URL 包含该子串（空 = 最近活动）
    maskCookies: true      # cookie 默认打码，要真值传 mask=false
    maxOutputChars: 60000
    callTimeoutMs: 60000
    pollMs: 500
    promptGuidance: true
```

`external` 模式才需要这些（0.2.0 起默认不用填）：

```yaml
    mode: external
    pythonPath: python3
    genericAgentDir: ~/mi-work/GenericAgent
```

## 坑的处理方式（skill 里靠人记，这里靠代码）

1. **`tabId` 必须是 int** —— 参数 schema 就是 `integer`，模型传字符串会被 `defineTool` 拦下。
2. **`Another debugger is already attached`** —— 报错信息里直接给出处置：换同域 tab。`Bridge.sticky` 会记住成功过的 tab 优先复用。
3. **`No response data in 15.0s`** —— 默认预算提到 60s；长任务还可以在调用里传 `timeout_ms`。
4. **`awaitPromise` 不加会拿到 `{}`** —— 默认走「window 变量 + 轮询」（`wrapAsyncEvaluation` / `readAsyncResult`），不依赖 awaitPromise；要直连才传 `await_promise: true`。
5. **导航要拆两次调用** —— `browser_navigate` 只做导航，工具描述里写明「下一步再用 browser_eval」。
6. **`{"cmd":"cookies"}` 漏 HttpOnly** —— 这里根本不用扩展的 cookies 命令，只走 `Network.getCookies`。
7. **扩展没回包 / 浏览器重启后扩展掉线** —— `Bridge.diagnose()` 会把「master 在线但 0 会话（扩展没连上）」和「master 没起」分开报，不用猜。

## 自测

```bash
cd plugins/dsh-browser-bridge

# 全部（推荐）
pnpm test          # 等价于 node test/all.mjs

# 或分开跑
node test/extension.test.mjs   # 扩展静态检查 + 协议对齐（manifest/图标/端口/报文类型）
node test/js-master.test.mjs   # 纯 JS master 协议（模拟扩展，不需要浏览器）
node test/smoke.mjs            # 插件整体：纯函数 + schema + 输出形状 + 真桥
```

`js-master.test.mjs` 覆盖：无扩展时报错可读、`ext_ready` 收会话、CDP 往返、
扩展 error 转可读错误、超时后 pending 清理、`tabs_update` 覆盖、断线清空、
重连恢复、端口占用报 `EADDRINUSE`、`stop()` 后端口可复用。

## 已知现场问题：后台标签页的 timer 被冻结

`browser_eval` 里写 `fetch(...)` 或 `new Promise(r=>setTimeout(...))`，在**后台标签页**
上会一直 `PENDING` —— Chrome/Edge 会冻结非活动页的 timer，`setTimeout` 不触发，fetch 也挂起。
同一段代码在 active 标签页上正常返回（已实测对比）。

插件会在这种情况下给出这个提示，不会让你以为是代码写错。处置：切到那个标签页
（`chrome.tabs.update({active:true})`，扩展的 `tabs` + `switch` 命令），或者换一个 active tab。

- 纯函数与 schema 检查不依赖 DSH 运行，直接跑。
- `@deepseek-ai/dsh-tools` 不在插件依赖里，用 `DSH_TOOLS_PATH` 指过去（默认取解包出来的 asar）。
- 真桥部分要看扩展此刻是否在线；扩展没回包时输出 `WARN` 并说明原因，不算插件缺陷。

## 与 skill 并存

装了插件后，`~/.dsh/skills/browser-cdp-control/` 建议删掉或改名——同一套坑写两遍，agent 会二选一猜。
想把「已知坑」留作文档，留着 `SKILL.md` 但别再 `skill` 加载：插件里的 `browser_tabs` / `browser_eval` 报错信息已经带处置建议。

## 为什么「插件管理面板里看不到」

加载成功 ≠ 面板里能看到。面板走 `PluginManager.listBundles()`，它有两道独立门槛：

1. **枚举源**是 `manifest.dependencies`（加上 `bundles`、installation、官方 catalog）。
   只在 `dsh.profile.bundles` 里写名字、不写 `dependencies`，插件照样会加载，
   但面板里 `installed=false`，看起来像"没装上"。
   → profile 的 `package.json` 里同时登记：`"dsh-browser-bridge": "link:../../../mi-work/mimo-swarm/plugins/dsh-browser-bridge"`。

2. **兼容性门槛** `evaluatePluginCompatibility()`：没有 `engines.dsh` 时，它会逐个检查
   `peerDependencies` 里的 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 是否满足**运行时版本**
   （`dsh-app-boot` 的 version，例如 `0.2.1-rc.2`）。`@deepseek-ai/cordis: ~4.0.5` 这个 range
   对 `0.2.1-rc.2` 永远不成立，于是插件被标成 `incompatible-version`。
   → 用 `engines.dsh` 表态（一旦存在就独占判定，peerDependencies 被忽略）：

   ```json
   "engines": { "node": ">=20", "dsh": ">=0.2.0-0 <0.3.0" }
   ```

   把 `@deepseek-ai/cordis` 移到 `devDependencies`——运行时由宿主提供，不是我们的依赖。

自检脚本（用运行时自己的判定函数，不是手写正则）：

```bash
node -e '
const { readFileSync } = require("fs");
import("file:///Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js")
  .then(m => console.log(m.evaluatePluginCompatibility(
    JSON.parse(readFileSync("package.json","utf8")), {}, "0.2.1-rc.2") ?? "OK"));
'
```

## 0.1.1 修复：Windows 上 `spawn python3 ENOENT` 会把 host 带崩

**症状**：目标机器（Windows）启动 DSH 直接报
`dsh desktop host exited with 1: fatal uncaught exception: Error: spawn python3 ENOENT`。

**两个独立问题叠在一起**：

1. `child_process.spawn` 失败时把 `error` 抛成**未捕获事件**，没有监听器就会终结整个
   host 进程 —— 所以不是「插件不可用」，而是「DSH 起不来」。修复：所有 spawn 走
   `spawnSafely()`，常驻 `error` 监听器；失败通过 `failure` promise 交给调用方。

2. Windows 上基本没有 `python3` 这个名字（真解释器叫 `python`，或 `py` launcher）。
   修复：`resolvePython()` 在 win32 上按 `python → py → python3` 探测；显式绝对路径不覆盖。

**顺带**：`genericAgentDir` 不存在时提前报错（以前会闷着头 spawn 到不存在的 cwd）。

配置建议（Windows）：

```yaml
- id: browser-bridge
  config:
    pythonPath: C:\Python312\python.exe   # 或留 python / py
    genericAgentDir: C:\path\to\GenericAgent
```

## 0.2.2 修复：`browser_cookie` 带 `include_local_storage` 必定输出校验失败

**症状**

```
Error: tool "browser_cookie" returned invalid output:
"value.localStorage" must match exactly one oneOf branch (matched 0)
```

**原因**：输出 schema 里 `localStorage` 被写成

```js
{ type: "object", additionalProperties: false, properties: {} }
```

这等于「必须是空对象」。而 `bridge.localStorage()` 返回的是 `{key: value}` 键值表，
只要页面的 localStorage 非空，就必然对不上。

**还有一个坑**：第一反应会想改成 `additionalProperties: { type: "string" }`，
但 DSH 的 schema 子集只接受 **boolean**：

```
schema.properties.localStorage.oneOf[0].additionalProperties must be explicitly true or false
```

所以正确写法是开放键：

```js
localStorage: {
  oneOf: [
    { type: "object", properties: {}, additionalProperties: true },
    { type: "null" },
  ],
}
```

**为什么 0.2.1 的测试没发现**：当时只断言了「schema 能被 `defineTool` 接受」，
没有拿真实返回值去跑输出校验。现在 `test/smoke.mjs` 会对每个工具用真实形状的值
调用 `validateJsonSchemaValue`，并且验证过「回退到旧 schema 时这两条测试会变红」。
