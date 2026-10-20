# 在别的电脑上使用 dsh-browser-bridge

三种方式，按「对方机器上有没有这个插件」选。

---

## 方式 A：打 tarball（推荐，离线/内网都能用）

在**这台机器**上打包：

```bash
cd /Users/will/mi-work/mimo-swarm/plugins/dsh-browser-bridge
npm pack --pack-destination /tmp
# → /tmp/dsh-browser-bridge-0.2.0.tgz
```

把 tgz 拷到目标机器，然后在目标机器上：

```bash
# 1) 放进 profile 并声明为依赖 + bundle
PROFILE="$HOME/.dsh/profiles/desktop"     # 或 web
cd "$PROFILE"

python3 - <<'PY'
import json, pathlib, os
p = pathlib.Path(os.environ["PROFILE"]) / "package.json"
d = json.loads(p.read_text())
d.setdefault("dependencies", {})["dsh-browser-bridge"] =
    "file:/absolute/path/to/dsh-browser-bridge-0.2.0.tgz"
d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if "dsh-browser-bridge" not in d["dsh"]["profile"]["bundles"]:
    d["dsh"]["profile"]["bundles"].append("dsh-browser-bridge")
p.write_text(json.dumps(d, indent=2) + "\n")
PY

# 2) 装下去
pnpm install

# 3) 重启 DSH
```

`dependencies` 和 `bundles` **两个都要写**：前者决定插件管理面板能不能看到它，
后者决定 loader 会不会把它当 bundle 层加载。只写一个会出现「能跑但看不到」或「看到但没生效」。

---

## 方式 B：git 仓库（多台机器反复同步时最省事）

把 `plugins/dsh-browser-bridge/` 推到一个 git 仓库（私有也行），目标机器：

```bash
cd "$HOME/.dsh/profiles/desktop"
pnpm add -D "git+https://<host>/<user>/dsh-browser-bridge.git#v0.2.0"
# 然后把 dsh-browser-bridge 加进 package.json 的 dsh.profile.bundles，重启
```

也可以在 GUI 里：设置 → 插件 → 安装，直接粘 `git+https://...` 或 tgz 的 URL
（安装器认 `registry` / `git` / `tarball` / `path` 四种 spec；本地路径必须是绝对路径）。

---

## 方式 C：同机软链（只有本机开发用）

```bash
ln -sfn /path/to/dsh-browser-bridge "$HOME/.dsh/profiles/desktop/node_modules/dsh-browser-bridge"
# package.json dependencies 里写 "link:/path/to/dsh-browser-bridge"
```

换机器就失效，别用它做分发。

---

## 目标机器还需要什么（0.2.0 起大幅简化）

| 依赖 | 需要吗 | 说明 |
|---|---|---|
| python3 | **不需要** | 0.2.0 自带 JS master |
| GenericAgent | **不需要** | 同上 |
| `simple_websocket_server` / `bottle` | **不需要** | 同上 |
| 浏览器扩展 `tmwd_cdp_bridge` | **需要** | 它是唯一真需要装的东西，见下 |

插件唯一的运行时依赖是 `ws`（纯 npm 包，纯 JS，`bufferutil`/`utf-8-validate` 都是可选加速，
Windows 上不需要编译器）。

### 扩展怎么装

把 `GenericAgent/assets/tmwd_cdp_bridge/` 整个目录拷到目标机器，然后：

- **Edge/Chrome**：`edge://extensions` / `chrome://extensions` → 打开「开发人员模式」→
  「加载解压缩的扩展」→ 选那个目录。
- 装好后它自己会去连 `ws://127.0.0.1:18765`，没连上就每 5 秒重试一次，不需要手动点。

### 端口冲突

`self` 模式要独占 **18765**。目标机器如果还留着旧的 Python master 占着这个端口，
插件会报 `EADDRINUSE` 并给出排查命令（`lsof -nP -iTCP:18765 -sTCP:LISTEN` /
Windows `netstat -ano | findstr 18765`）。杀掉旧的即可，扩展会自动连到新的 JS master。

## 装完怎么验

1. **loader 层**（有没有被当 bundle 加载）：

   ```bash
   DSH_HOME=$HOME/.dsh dsh --profile desktop --dump-config | grep -A 12 "browser-bridge"
   ```

2. **兼容性门槛**（会不会在面板里显示成 incompatible）：

   ```bash
   cd <plugin-dir>
   node -e '
   const { readFileSync } = require("fs");
   import("file:///Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js")
     .then(m => console.log(m.evaluatePluginCompatibility(
       JSON.parse(readFileSync("package.json","utf8")), {}, "0.2.1-rc.2") ?? "OK"));
   '
   ```

   必须是 `OK`。

   **版本写法很关键**：`evaluatePluginCompatibility` 会把每个 `@deepseek-ai/dsh*`
   peer 的 range 拿去和 runtime 版本（`0.2.1-rc.2`）比对。

   | 写法 | 结果 |
   |---|---|
   | `"@deepseek-ai/dsh-tools": "0.2.1-rc.2"`（官方做法，精确版本） | 通过 |
   | `">=0.2.0-0 <0.3.0"` | 通过 |
   | `"@deepseek-ai/cordis": "~4.0.5"` | **不通过**（cordis 是 4.x，永远不等于 0.2.x） |

   所以宿主 API 只敢写 `@deepseek-ai/dsh*` 的 peer，且 range 要覆盖 runtime 版本；
   `cordis` 这类非 dsh 版本线的包才写 `*` 或具体版本。
   另外 `schemastery` 要写成 **dependency**（官方 `dsh-tool-web` 就是这么干的），
   写成 optional peer 会被 pnpm 跳过，运行时 `ERR_MODULE_NOT_FOUND`。

3. **运行时**：重启 DSH 后在会话里依次调

   ```
   browser_install                        → master: ws://127.0.0.1:18765，扩展已连上：是
   browser_tabs                           → 能看到标签页
   browser_eval(tab_id=<某个>, js="1+1")   → 2
   ```

   第二条如果显示「扩展已连上：否」，去浏览器 `chrome://extensions` 把 `tmwd_cdp_bridge`
   关掉再打开，5 秒内会自动连上。

4. **异步必须用 active 标签页**：后台标签页的 `setTimeout` 被浏览器冻结，
   `fetch` 也会挂起，`browser_eval` 会一直 PENDING。切到那个标签页再试。

---

## 一个坑：端口被旧 Python master 占着

`self` 模式要独占 18765。如果目标机器上还跑着旧的 Python TMWebDriver master，
`browser_install` 会报 `EADDRINUSE`。

```bash
# macOS / Linux
lsof -nP -iTCP:18765 -sTCP:LISTEN
kill <PID>
# Windows
netstat -ano | findstr 18765
taskkill /PID <PID> /F
```

杀掉后扩展会自动连到插件的 JS master，不需要动扩展。
