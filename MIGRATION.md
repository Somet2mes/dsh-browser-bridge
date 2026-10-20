# browser-cdp-control（skill）→ dsh-browser-bridge（插件）

## 为什么改

| | skill | 插件 |
|---|---|---|
| 用法 | `skill browser-cdp-control` → 读 133 行 Markdown → agent 自己拼 Python → 自己起 master | 五个工具常驻，`browser_eval` 直接调 |
| 参数校验 | 无，写错 `tabId` 类型要跑一次才知道 | `defineTool` schema，传错在调用前就被拒 |
| Promise 取值 | 要记得加 `awaitPromise`，否则拿到 `{}` | 默认 window 轮询，不需要记 |
| HttpOnly cookie | 要记得不能用 `{"cmd":"cookies"}` | 只有 `Network.getCookies` 一条路 |
| 超时 | 默认 15s，会留下挂死的 debugger | 默认 60s，报错直接给处置建议 |
| 打码 | 要自己写 mask | `maskCookies: true` 默认打码 |
| master | 要自己 `python3 -c "while True: sleep"` | `autoStart` 起，或 `browser_install` |
| 诊断 | 靠踩坑经验 | `diagnose()` 分开报「master 没起」和「扩展没连上」 |

## 能力对照

| skill 里的写法 | 插件里的写法 |
|---|---|
| `d.get_all_sessions()` | `browser_tabs(url_contains="infosec.pt")` |
| `execute_js({"cmd":"cdp","method":"Runtime.evaluate",...})` | `browser_eval(tab_id=..., js="location.href")` |
| `window.__out` + 轮询 | `browser_eval(js="fetch('/api/x').then(r=>r.json())")`（内部自动轮询） |
| `Network.getCookies` + 拼 header | `browser_cookie(tab_id=..., url=..., mask=false)` → `header` |
| `localStorage` 取 token | `browser_cookie(..., include_local_storage=true)` |
| `jump(url)` | `browser_navigate(tab_id=..., url=...)` |
| 起 keep-alive master | `browser_install(wait_ms=15000)` |

## 迁移后要删的东西

`~/.dsh/skills/browser-cdp-control/`（`SKILL.md` + `tmwd_helpers.py`）已经不再被需要。
两套并存时 agent 会二选一猜，反而更慢。想留档就挪到 `docs/` 下，别放在 skills 目录。

## 安装记录（本机已做）

```
~/.dsh/profiles/desktop/node_modules/dsh-browser-bridge -> plugins/dsh-browser-bridge
~/.dsh/profiles/web/node_modules/dsh-browser-bridge     -> plugins/dsh-browser-bridge
```

两个 profile 的 `package.json` → `dsh.profile.bundles` 末尾追加了 `dsh-browser-bridge`；
desktop 的 `cordis.patch.yml` 末尾加了一段 `- id: browser-bridge` 的 config 覆盖。

已验证：
- `dsh --profile web --dump-config` 组合出 `browser-bridge` 行；
- 用临时 profile 真启动一次，**没有** `entry did not activate` 警告（插件已激活）；
- `node test/smoke.mjs` 全绿（schema、NDJSON、状态机、真桥列会话）。

桌面端要重启 DeepSeek Harness 才能加载新 bundle。

## 已知遗留

当前 master（PID 88180，10-15 11:36 启动）在浏览器重启后**扩展侧不再 ACK**：
`execute_js` 一律 `No response data`，`get_all_sessions` 仍是旧的 40 条快照。
这是扩展/守候进程的问题，不是插件的问题——插件会把这件事明确报出来。
处置：重启那个守候进程 + 在 Edge 里把 `tmwd_cdp_bridge` 扩展关掉重开。
