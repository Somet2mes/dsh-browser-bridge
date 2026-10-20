# TMWD CDP Bridge（浏览器扩展）

`dsh-browser-bridge` 的浏览器侧。它把一个**已登录的** Edge/Chrome 标签页能力桥接给插件：

- 页内执行 JS（含 Promise / `fetch`）
- CDP 透传（`Runtime.evaluate` / `Network.getCookies` 等）
- 全量 cookie（含 HttpOnly）
- 标签页列表、新建、切换

它本身是个 **WebSocket 客户端**，会主动连 `ws://127.0.0.1:18765`。
18765 上谁来听它就跟谁走 —— 0.2.0 起是插件的 JS master，之前是 Python 的 TMWebDriver。

---

## 安装

**这个扩展没有上架商店，只能以「加载解压缩的扩展」方式装。** 三步：

### 1. 拿到 `extension/` 目录

三种途径任选：

```bash
# a) 已经从 GitHub 装了插件包：目录就在插件里
<profile>/node_modules/dsh-browser-bridge/extension

# b) 直接下仓库
git clone https://github.com/Somet2mes/dsh-browser-bridge.git
# 用 dsh-browser-bridge/extension/

# c) 下载 zip 解压
# https://github.com/Somet2mes/dsh-browser-bridge/archive/refs/heads/main.zip
```

### 2. 在浏览器里加载

**Edge**：地址栏输入 `edge://extensions`
**Chrome**：地址栏输入 `chrome://extensions`

1. 打开右下角/右上角的「**开发人员模式**」/「开发者模式」
2. 点「**加载解压缩的扩展**」/「加载已解压的扩展程序」
3. 选中上一步的 `extension` 目录（**是 `extension` 这一层，不是它的上级**）

加载成功后列表里会出现 “TMWD CDP Bridge 2.0.0”。

> 因为用了 `debugger` 权限，Chrome 会在顶部提示「TMWD CDP Bridge 正在调试此浏览器」，
> 这是它调用 CDP 的必要条件，属正常现象。

### 3. 确认连上了

打开任意网页，右下角会出现一个小标签：

| 显示 | 含义 |
|---|---|
| `ljq_driver: 已连接`（绿） | 已连上 18765，可以用了 |
| `ljq_driver: 重连中`（橙） | 18765 上没人监听，或插件还没启动；每 5 秒自动重试 |
| `ljq_driver: 断开`（红） | 连接掉了，同上 |

也可以点扩展图标看 popup（CLI 里还会列出 cookie）。

**先启动插件再开浏览器**不是必须的 —— 扩展会一直重试，插件起来后 5 秒内自动连上。

---

## 后端起来之前显示「重连中」是正常的

扩展的探测逻辑是：每 5 秒 `fetch http://127.0.0.1:18765`，通了就建 WebSocket。
所以在 DSH 还没启动、或插件还没被调用时，它显示「重连中／断开」完全正常。

让插件起 master 的方式（任一）：

- 重启 DSH，然后在会话里随便调一次 `browser_tabs`（惰性启动）
- 或直接调 `browser_install`

---

## 权限说明

`manifest.json` 申请的权限，全部服务于「在本机浏览器里代你操作页面」：

| 权限 | 用途 |
|---|---|
| `debugger` | CDP 透传（`Runtime.evaluate`、`Network.getCookies`），也是唯一能绕过页面 CSP 执行脚本的路 |
| `tabs` / `activeTab` | 列出标签页、切换、取新开标签页的 URL |
| `cookies` | `Network.getCookies` 拿不到某些场景时的补充（主力仍是 CDP） |
| `scripting` | `chrome.scripting.executeScript` 在页面 MAIN world 跑脚本 |
| `alarms` | MV3 service worker 会被回收；用 alarm 唤醒并保活 WebSocket |
| `declarativeNetRequest` | 按需改写响应头，绕开少数站点的体检 |
| `management` / `contentSettings` | popup 里的扩展管理面板，和个别站点的内容设置调整 |
| `host_permissions: <all_urls>` | 你要操作哪个站点它就得能碰哪个站点，所以是全量 |

**这些权限组合起来等价于「完全控制这个浏览器」，别装到有敏感账号的日常 profile 上。**
建议用一个专用 profile 登录目标站点。

---

## 出处与授权

这个扩展是 [GenericAgent](https://github.com/lsdefine/GenericAgent)（MIT License, © 2025 lsdefine）
的资产 `assets/tmwd_cdp_bridge/`，这里原样收录以便一件安装。

相对上游的改动：

- `manifest.json`：`version` 改为 `2.0.0`；补 `icons` 与 `action.default_icon`；描述文字更新
- 新增 `icons/*.png`（上游没有图标）
- 其余 `background.js` / `content.js` / `disable_dialogs.js` / `popup.html` / `popup.js` **未改动**

上游的 `config.js`（只有一个未被任何文件引用的常量）没有收录。

协议与上游保持一致，所以这个扩展既能连插件的 JS master，也能连原版 Python master。

---

## 常见问题

**加载时报 “清单文件缺失或不可读取”**
选错目录了。要选的是 `extension/`，里面直接躺着 `manifest.json`；
不是 `extension/extension/manifest.json`，也不是 `dsh-browser-bridge/`。

**显示「已连接」但 `browser_tabs` 返回 0 个标签页**
扩展只上报 http/https 标签页。`chrome://`、`edge://`、`about:`、扩展页都不会列出来。
先去打开一个正常网页。

**改了扩展代码没生效**
`chrome://extensions` 里点那个扩展卡片上的「重新加载」，然后刷新页面。

**端口被占**
18765 只能有一个监听者。旧的 Python master 还活着的话，插件会报 `EADDRINUSE`：

```bash
# macOS / Linux
lsof -nP -iTCP:18765 -sTCP:LISTEN
kill <PID>
# Windows
netstat -ano | findstr 18765
taskkill /PID <PID> /F
```

杀掉后扩展会自动连到新的监听者，不用动扩展。
