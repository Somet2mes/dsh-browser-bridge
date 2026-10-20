/**
 * TMWebDriver master 的 HTTP 客户端（Node 原生 fetch，零依赖）。
 *
 * master 就是 `TMWebDriver.py`（GenericAgent）起的那个进程：
 *   - 18765  WebSocket，给浏览器扩展（tmwd_cdp_bridge）用
 *   - 18766  HTTP，POST /link 是外部控制入口
 *
 * 这里只走 18766，因为 Node 侧接 WebSocket 需要额外库；HTTP /link 支持
 * get_all_sessions / find_session / execute_js 三个命令，等价能力全覆盖。
 *
 * 注意 NDJSON：master 的 `link()` 会 `return 'ok'` 之后又会 `return json.dumps(...)`，
 * 两个 return 都会写进响应，所以响应体是两行。只解析第一个能解析出 JSON 的行。
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { JsMaster } from "./js-master.js";

/** master HTTP 端口 = WebSocket 端口 + 1（TMWebDriver 的约定）。 */
export const DEFAULT_WS_PORT = 18765;
export const DEFAULT_HTTP_PORT = DEFAULT_WS_PORT + 1;

/**
 * 解析 /link 响应里的 NDJSON：取第一个合法 JSON 行。
 * @param {string} text
 * @returns {any}
 */
export function parseLinkBody(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* 继续找下一行 */
    }
  }
  throw new Error(`TMWebDriver 返回了非 JSON 响应：${String(text ?? "").slice(0, 200)}`);
}

/** TCP 探测端口是否有人监听。 */
export function probePort(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 目标平台：允许测试注入，默认取真实平台。 */
function hostPlatform() {
  return process.platform;
}

/**
 * Windows 上 python3 / python3.12 常常只是 Microsoft Store 的占位 stub，或压根不存在；
 * 真解释器通常叫 python 或 py。这里按候选顺序探测，返回第一个能跑通的。
 * 非 Windows 原样返回，交给系统 PATH 解析。
 * @param {string} requested 配置里的 pythonPath
 * @param {{platform?: string, exists?: (p: string) => boolean}} [probe]
 * @returns {string}
 */
export function resolvePython(resolved, probe = {}) {
  const platform = probe.platform ?? hostPlatform();
  const exists = probe.exists ?? ((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  // 显式给了绝对路径就别自作主张
  if (path.isAbsolute(resolved)) return resolved;
  if (platform !== "win32") return resolved;

  const base = path.basename(resolved).toLowerCase();
  const isPythonish = /^python(\d+(\.\d+)?)?$/.test(base) || base === "py";
  if (!isPythonish) return resolved;

  const candidates = requestedCandidates(base);
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  // 都不存在：返回最可能的那个，让错误信息里出现可执行的下一步
  return candidates[0] ?? resolved;
}

/** Windows 下 python 命令的候选清单（按优先级）。 */
export function requestedCandidates(base) {
  if (base === "py") return ["py"];
  if (base === "python") return ["python", "py"];
  // python3 / python3.x：Windows 上优先试 python，再试 py
  return ["python", "py", base];
}

/**
 * 安全 spawn：**必须**监听 error 事件。
 * ChildProcess 在 spawn 失败时把 'error' 抛成未捕获异常，不加监听器会直接
 * 干掉整个 DSH host 进程（Windows 上 python3 不存在时就是这么崩的）。
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} options
 * @returns {{child: import("node:child_process").ChildProcess, failure: Promise<Error>}}
 *   `failure` 在 spawn 失败时 resolve 成那个 Error（不会 reject，调用方可以 race）。
 */
export function spawnSafely(command, args, options) {
  const child = spawn(command, args, options);
  let settle;
  const failure = new Promise((resolve) => {
    settle = resolve;
  });
  child.on("error", (error) => {
    // 常驻监听器：同时消费掉后续 error，避免 EPIPE 之类二次抛出
    settle(error);
  });
  return { child, failure };
}

/**
 * 把 spawn 失败翻译成「用户能照着做」的错误。
 * @param {string} python 实际尝试的解释器
 * @param {Error & {code?: string}} error
 * @param {string} configured 配置里写的 pythonPath 原文
 */
export function spawnFailureError(python, error, configured) {
  const code = error?.code ?? "";
  if (code === "ENOENT") {
    const hint =
      process.platform === "win32"
        ? `Windows 上没有 \`${python}\`。安装 Python 并勾选「Add python.exe to PATH」，` +
          `或把配置项 pythonPath 改成绝对路径（例如 C:\\Python312\\python.exe）；` +
          `也可以试 python / py。`
        : `\`${python}\` 不在 PATH 上。装 Python 3，或把配置项 pythonPath 改成绝对路径。`;
    return new Error(`起不了 TMWebDriver master：${hint}（配置值：${configured ?? python}）`);
  }
  if (code === "EACCES") {
    return new Error(`起不了 TMWebDriver master：${python} 没有执行权限（EACCES）。换一个解释器路径。`);
  }
  return new Error(`起不了 TMWebDriver master：spawn ${python} 失败（${code || error?.message}）。`);
}

/** `~/x` → `/Users/x/x`；其它路径原样。 */
export function expandHome(value) {
  if (typeof value !== "string" || value.length === 0) return os.homedir();
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * 把一次页面内异步任务的公共外壳包成表达式：把结果写进 window.__dshBridge，
 * 状态机 PENDING → OK / ERR，避免依赖 CDP 的 awaitPromise（桥 15s 超时会挂死 debugger）。
 * @param {string} js 用户 JS（函数体或表达式）
 * @param {string} outKey 结果落在 window[outKey]
 * @param {string} __c 注入的 CDP 调用名（eval / evalAsync）
 */
export function wrapAsyncEvaluation(js, outKey) {
  // 关键：这一段整体是**同步返回 "STARTED"** 的表达式。
  // 扩展侧 buildExecScript 的规则是「eval 结果如果是 Promise 就 await」——
  // 所以这里绝不能把 async 函数/Promise 交回去（那样扩展会去序列化一个 Promise，
  // 拿到 {} 或 null）。真正的结果走 window[outKey] 的状态机，插件侧轮询。
  return `(() => {
  const K = ${JSON.stringify(outKey)};
  const put = (ok, v) => {
    let s;
    try {
      if (v === undefined) s = "null";
      else if (typeof v === "string") s = v;
      else {
        const seen = new WeakSet();
        s = JSON.stringify(v, (key, value) => {
          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return "[circular]";
            seen.add(value);
            if (value === window || value === document) return "[window]";
            if (value.nodeType === 1) return "[element:" + (value.tagName || "") + "]";
          }
          return value;
        });
        if (s === undefined) s = String(v);
      }
    } catch (e) { s = String(v); }
    window[K] = ok ? "OK" + s : "ERR" + s;
  };
  window[K] = "PENDING";
  try {
    const script = ${JSON.stringify(js)};
    let r;
    try {
      // 用户写的是表达式：fetch('/x').then(r => r.json())
      r = (0, eval)("(" + script + ")");
    } catch (inner) {
      // 是语句（含 return / 多行）：用 AsyncFunction 包，能直接写 await
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      r = new AsyncFunction(script)();
    }
    if (r && typeof r.then === "function") {
      r.then((v) => put(true, v), (e) => put(false, (e && (e.stack || e.message)) || String(e)));
    } else {
      put(true, r);
    }
  } catch (e) {
    put(false, (e && (e.stack || e.message)) || String(e));
  }
  return "STARTED";
})()`;
}

/** 拆出 window[K] 的状态机值。 */
export function readAsyncResult(raw, outKey) {
  if (typeof raw !== "string") return { state: "PENDING", raw };
  if (raw === "PENDING") return { state: "PENDING", raw };
  if (raw.startsWith("ERR")) return { state: "ERR", value: raw.slice(3), raw };
  if (raw.startsWith("OK")) return { state: "OK", value: raw.slice(2), raw };
  return { state: "DONE", value: raw, raw };
}

/**
 * Bridge：一次插件生命周期内复用的 master 客户端。
 */
export class Bridge {
  /**
   * @param {{host?: string, port?: number, envelopeTimeoutMs?: number, autoStart?: boolean,
   *          mode?: "self"|"external", pythonPath?: string, startScript?: string,
   *          log?: (msg: string) => void}} [options]
   */
  constructor(options = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? DEFAULT_HTTP_PORT;
    this.wsPort = options.port - 1;
    /**
     * self     = 插件自己起一个纯 JS master（默认，不需要 python）
     * external = 连已有的 Python master 的 HTTP /link（兼容旧部署）
     */
    this.mode = options.mode ?? "self";
    /** @type {JsMaster|null} */
    this.master = null;
    this.envelopeTimeoutMs = options.envelopeTimeoutMs ?? 60_000;
    this.autoStart = options.autoStart !== false;
    this.pythonPath = options.pythonPath ?? "python3";
    /** 启动脚本：默认内联，可用配置换成任意能主动起 master 的脚本。 */
    this.startScript = options.startScript || Bridge.defaultStartScript();
    this.log = options.log ?? (() => {});
    /** GenericAgent 目录：放启动脚本和 PYTHONPATH。 */
    this.genericAgentDir = options.genericAgentDir ?? "~/mi-work/GenericAgent";
    /** @type {Promise<void>|null} */
    this.starting = null;
    /** @type {Map<number, {tabId:number}|null>} tabId → debugger 粘滞记录 */
    this.sticky = new Map();
  }

  static defaultStartScript() {
    return [
      "import time, socket",
      "from TMWebDriver import TMWebDriver",
      "d = TMWebDriver()",
      "if not getattr(d, 'is_remote', False):",
      "    while True: time.sleep(3600)",
      "else:",
      "    time.sleep(0)",
    ].join("\n");
  }

  get url() {
    return `http://${this.host}:${this.port}/link`;
  }

  /** master 是否在跑（HTTP 端口在听）。 */
  async isAlive() {
    return probePort(this.host, this.port);
  }

  /** self 模式下：本进程的 JS master 是否在听。 */
  get selfListening() {
    return this.master?.listening === true;
  }

  /** 当前模式下扩展是否已连上来。 */
  get hasExtension() {
    return this.master ? this.master.clients.size > 0 : false;
  }

  /**
   * 确保能干活：self 模式起本进程 master；external 模式确认 HTTP 端口在听。
   * @param {{startTimeoutMs?: number}} [options]
   */
  async ensureReady(options = {}) {
    if (this.mode === "external") return this.ensure({ startTimeoutMs: options.startTimeoutMs });
    if (this.selfListening) return { started: false };
    if (!this.master) {
      this.master = new JsMaster({ host: this.host, port: this.wsPort, log: this.log });
    }
    try {
      await this.master.start();
      return { started: true };
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        // 端口被占：可能是旧的 Python master，也可能是别的实例。不抢，
        // 但要说清楚——两种情况下都没有扩展连到「我们」这边。
        throw new Error(
          `${this.wsPort} 已被占用，无法起 JS master。` +
            `如果是旧的 Python master（GenericAgent）在跑，先把它停掉：` +
            `lsof -nP -iTCP:${this.wsPort} -sTCP:LISTEN；` +
            `Windows: netstat -ano | findstr ${this.wsPort}`,
        );
      }
      throw error;
    }
  }

  /** 停掉本进程的 JS master（只在自己起的才停）。 */
  async shutdown() {
    if (this.master) {
      await this.master.stop();
      this.master = null;
    }
  }

  /**
   * POST /link。
   * @param {Record<string, any>} payload
   * @param {{timeoutMs?: number}} [options]
   */
  async link(payload, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`TMWebDriver HTTP ${response.status}：${text.slice(0, 200)}`);
      }
      return parseLinkBody(text);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`TMWebDriver 在 ${timeoutMs}ms 内没有响应（${this.url}）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 确认 master 在线，不在就（可选）拉起来。
   * @param {{autoStart?: boolean, startTimeoutMs?: number}} [options]
   */
  async ensure(options = {}) {
    if (await this.isAlive()) return { started: false };
    const autoStart = options.autoStart ?? this.autoStart;
    if (!autoStart) {
      throw new Error(
        `TMWebDriver master 没有在 ${this.host}:${this.port} 监听。` +
          `先启动：cd <GenericAgent> && ${this.pythonPath} -c <startScript>（或把 autoStart 打开）`,
      );
    }
    if (!this.starting) {
      this.starting = this.#spawn(options.startTimeoutMs ?? 12_000).finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
    return { started: true };
  }

  async #spawn(startTimeoutMs) {
    const cwd = expandHome(this.genericAgentDir);
    if (!fs.existsSync(cwd)) {
      throw new Error(
        `genericAgentDir 不存在：${cwd}。` +
          `把它配成对方机器上 GenericAgent（含 TMWebDriver.py）的绝对路径，例如 Windows：C:\\path\\to\\GenericAgent`,
      );
    }

    const python = resolvePython(this.pythonPath);
    this.log(`拉起 TMWebDriver master（${python}，cwd=${cwd}）`);

    const { child, failure } = spawnSafely(python, ["-u", "-c", this.startScript], {
      cwd,
      env: { ...process.env, PYTHONPATH: [cwd, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    // spawn 失败必须在这里被接住：否则未捕获的 'error' 事件会让整个 DSH host 退出。
    let spawnError;
    failure.then((error) => {
      spawnError = error;
    });
    child.unref();

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnFailureError(python, spawnError, this.pythonPath);
      if (await this.isAlive()) {
        await sleep(200);
        return;
      }
      await sleep(250);
    }
    if (spawnError) throw spawnFailureError(python, spawnError, this.pythonPath);
    throw new Error(
      `尝试拉起 TMWebDriver 失败（${startTimeoutMs}ms 内 ${this.host}:${this.port} 仍未监听）。` +
        `解释器 ${python} 能启动但 master 没起来：检查 ${cwd} 下的 TMWebDriver.py，以及 ` +
        `simple_websocket_server、bottle 是否已装（${python} -c "import simple_websocket_server, bottle"）。`,
    );
  }

  /**
   * 诊断：master 在线但调用不成功时，帮模型判断是谁的问题。
   * @returns {Promise<{alive: boolean, sessions: number, hint: string}>}
   */
  async diagnose() {
    if (this.mode === "self") {
      if (!this.selfListening) {
        return { alive: false, sessions: 0, hint: "JS master 还没起：browser_install，或在工具里直接调用会惰性启动。" };
      }
      const sessions = this.master.listTabs();
      if (sessions.length === 0) {
        return {
          alive: true,
          sessions: 0,
          hint: this.hasExtension
            ? "扩展已连上但一个可操作标签页都没有：先打开任意 http(s) 页面。"
            : `JS master 在 ${this.master.address} 监听，但没有扩展连上来。把 Edge/Chrome 里的 tmwd_cdp_bridge 扩展关掉重开。`,
        };
      }
      return { alive: true, sessions: sessions.length, hint: `JS master 在线，${sessions.length} 个会话` };
    }
    if (!(await this.isAlive())) {
      return { alive: false, sessions: 0, hint: "master 没在跑：browser_install 拉起，或检查 autoStart / pythonPath" };
    }
    try {
      const sessions = await this.sessions();
      if (sessions.length === 0) {
        return {
          alive: true,
          sessions: 0,
          hint:
            "master 在线但没有任何标签页会话：浏览器里的 tmwd_cdp_bridge 扩展没连上。" +
            "把扩展关掉重开，或点扩展里的 reconnect；连上后 browser_tabs 立刻能看到。",
        };
      }
      return { alive: true, sessions: sessions.length, hint: `master 在线，${sessions.length} 个会话` };
    } catch (error) {
      return { alive: true, sessions: 0, hint: `master 在线但 get_all_sessions 出错：${error.message}` };
    }
  }

  /** @returns {Promise<Array<{id: string, url: string, title: string, type: string}>>} */
  async sessions() {
    if (this.mode === "self") {
      if (!this.selfListening) await this.ensureReady();
      return this.master.listTabs().map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, type: "ext_ws" }));
    }
    const payload = await this.link({ cmd: "get_all_sessions" });
    const list = payload?.r;
    if (!Array.isArray(list)) throw new Error(`get_all_sessions 返回异常：${JSON.stringify(payload).slice(0, 300)}`);
    return list;
  }

  /** 按 URL 子串找会话（同 URL 多条时全部返回）。 */
  async findSessions(pattern) {
    const payload = await this.link({ cmd: "find_session", url_pattern: pattern ?? "" });
    const list = payload?.r;
    if (!Array.isArray(list)) throw new Error(`find_session 返回异常：${JSON.stringify(payload).slice(0, 300)}`);
    return list.map(([id, info]) => ({ id: String(id), ...info }));
  }

  /**
   * 给某个 tab 发一条扩展命令。
   * @param {string} sessionId tab 的 id（数字字符串）
   * @param {Record<string, any>} command 扩展命令（含 cmd 字段）
   * @param {{timeoutMs?: number}} [options]
   */
  async send(sessionId, command, options = {}) {
    if (this.mode === "self") {
      if (!this.selfListening) await this.ensureReady();
      const { data } = await this.master.send(sessionId, command, {
        timeoutMs: options.timeoutMs ?? this.envelopeTimeoutMs,
      });
      return data;
    }
    const timeoutSec = Math.max(1, Math.round((options.timeoutMs ?? this.envelopeTimeoutMs) / 1000));
    const payload = await this.link(
      { cmd: "execute_js", sessionId: String(sessionId), code: JSON.stringify(command), timeout: String(timeoutSec) },
      { timeoutMs: (options.timeoutMs ?? this.envelopeTimeoutMs) + 15_000 },
    );
    const r = payload?.r;
    if (r?.error) throw new Error(String(r.error));
    if (r && typeof r === "object" && "result" in r) {
      const result = r.result;
      if (typeof result === "string" && result.startsWith("No response data in")) {
        throw new Error(
          `${result}：扩展在 ${timeoutSec}s 内没回包（tab ${sessionId}）。` +
            `先 browser_tabs 换一个 tab 重试；仍不回包就说明 tmwd_cdp_bridge 扩展这一侧断了，` +
            `去扩展里 reconnect（浏览器重启后常见）。`,
        );
      }
      return result;
    }
    return r;
  }

  /** CDP 方法透传。 */
  async cdp(sessionId, method, params, options = {}) {
    const command = { cmd: "cdp", tabId: Number(sessionId), method };
    if (params !== undefined) command.params = params;
    const raw = await this.send(sessionId, command, options);
    if (raw && typeof raw === "object" && raw.result !== undefined) return raw.result;
    return raw;
  }

  /** Runtime.evaluate，returnByValue。 */
  async evaluate(sessionId, expression, options = {}) {
    const params = { expression, returnByValue: true };
    if (options.awaitPromise) params.awaitPromise = true;
    if (options.userGesture) params.userGesture = true;
    const result = await this.cdp(sessionId, "Runtime.evaluate", params, options);
    if (result && typeof result === "object" && result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime.evaluate 抛了异常";
      throw new Error(description);
    }
    return result && typeof result === "object" && "value" in result ? result.value : result;
  }

  /** 页面内跑任意 JS；返回同步值 / Promise 结果（轮询 window 变量）。 */
  async runJs(sessionId, js, options = {}) {
    const outKey = "__dsh_bridge_out__";
    const normalize = (value) => {
      if (typeof value !== "string") return value === undefined ? null : value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };

    if (options.mode === "awaitPromise") {
      try {
        const value = await this.evaluate(sessionId, js, { ...options, awaitPromise: true });
        const parsed = normalize(value);
        return { pending: false, value: parsed, raw: value };
      } catch (error) {
        if (options.strictAwait) throw error;
      }
    }

    const started = await this.evaluate(sessionId, wrapAsyncEvaluation(js, outKey), options);
    if (started !== "STARTED" && options.mode !== "poll") {
      // 老表达式里 already 返回值
      return { pending: false, value: normalize(started), raw: started };
    }
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    const pollMs = options.pollMs ?? 500;
    let last = "PENDING";
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const raw = await this.evaluate(sessionId, `window[${JSON.stringify(outKey)}]`, options);
      const state = readAsyncResult(raw, outKey);
      last = state.raw;
      if (state.state === "OK" || state.state === "DONE") {
        return { pending: false, value: normalize(state.value), raw: state.raw };
      }
      if (state.state === "ERR") {
        throw new Error(`页面内 JS 抛错：${state.value}`);
      }
    }
    return {
      pending: true,
      value: null,
      raw: last,
      hint:
        "页面里的 Promise 一直 PENDING。最常见原因：这是个**后台标签页**——Chrome/Edge 会冻结" +
        "后台页的 timer，setTimeout 永远不触发，fetch 也被挂起。用 browser_tabs 里 active 的那个 tab，" +
        "或先 browser_navigate/指向扩展的 tabs.switch 把它激活。",
    };
  }

  /** 全量 cookie（含 HttpOnly）。 */
  async cookies(sessionId, urls, options = {}) {
    const result = await this.cdp(sessionId, "Network.getCookies", { urls }, options);
    return Array.isArray(result?.cookies) ? result.cookies : [];
  }

  /** localStorage 转普通对象。 */
  async localStorage(sessionId, options = {}) {
    const value = await this.evaluate(
      sessionId,
      "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))",
      options,
    );
    try {
      return JSON.parse(value ?? "{}");
    } catch {
      return {};
    }
  }

  /** 导航（必须单独一次调用，别和后续操作拼一起）。 */
  async navigate(sessionId, url, options = {}) {
    const target = JSON.stringify(url);
    if (!/^https?:|^about:/.test(String(url))) {
      throw new Error("browser_navigate 只接受 http(s) URL");
    }
    return this.evaluate(sessionId, `(location.href = ${target}, "navigating")`, options);
  }

  /** 打一批命令（扩展 batch），一次往返。 */
  async batch(sessionId, commands, options = {}) {
    const raw = await this.send(sessionId, { cmd: "batch", commands }, options);
    return Array.isArray(raw) ? raw : [];
  }

  /** 挑一个可用 tab：优先上次成功过的，再按 URL 匹配。 */
  pickTab(tabs, urlContains) {
    const matched = urlContains ? tabs.filter((tab) => String(tab.url ?? "").includes(urlContains)) : tabs.slice();
    const candidates = matched.length > 0 ? matched : urlContains ? [] : tabs.slice();
    if (candidates.length === 0) return undefined;
    const previous = candidates.find((tab) => this.sticky.get(Number(tab.id)) === "ok");
    return previous ?? candidates[0];
  }

  markSticky(tabId, state) {
    if (tabId === undefined || tabId === null) return;
    if (state === "ok") this.sticky.set(Number(tabId), { tabId: Number(tabId) });
    else if (state === "broken") this.sticky.delete(Number(tabId));
  }
}
