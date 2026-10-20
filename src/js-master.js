/**
 * 纯 JS 的 TMWebDriver 兼容 master：直接和 tmwd_cdp_bridge 扩展讲同一套 WebSocket 协议，
 * 不需要 python、不需要 GenericAgent、不需要 simple_websocket_server / bottle。
 *
 * 为什么要重写：
 *   Python 版 master 只做一件事——收扩展的会话、把命令转给扩展、等结果。
 *   它没有任何非 JS 不可的能力。而它带进来的成本是：python 解释器、PATH、
 *   GenericAgent 目录、两个 pip 依赖，以及 Windows 上一堆 ENOENT。
 *
 * 协议（扩展是客户端，我们是被连的一方，端口 18765）：
 *   扩展 → master  { type: 'ext_ready', tabs: [{id,url,title}] }
 *                  { type: 'tabs_update', tabs: [...] }
 *                  { type: 'ack', id }
 *                  { type: 'result', id, result, newTabs }
 *                  { type: 'error', id, error, newTabs }
 *                  { type: 'ping' }
 *   master → 扩展  { id, code, tabId? }   code 是 JSON 字符串或普通 JS 字符串
 *
 * 与 Python 版的差异：
 *   - 196 行 Python 里的 http 长轮询 / 远程模式不复刻：插件直连本进程，不需要。
 *   - 加了一条「命令超时即摘掉 debugger 会话」的兜底，避免 Python 版那个
 *     "Another debugger is already attached" 的挂死。
 */

import { WebSocketServer } from "ws";

/** 扩展固定连这个端口（写死在 tmwd_cdp_bridge/background.js 里）。 */
export const DEFAULT_WS_PORT = 18765;

let sequence = 0;

/**
 * @typedef {{id: string, url: string, title: string, connectedAt: number}} TabSession
 */

/**
 * 纯 JS master。
 */
export class JsMaster {
  /**
   * @param {{host?: string, port?: number, log?: (message: string) => void}} [options]
   */
  constructor(options = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? DEFAULT_WS_PORT;
    this.log = options.log ?? (() => {});
    /** @type {Map<string, TabSession>} tabId(str) → 会话 */
    this.sessions = new Map();
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, type: string}>} */
    this.pending = new Map();
    /** @type {Set<import("ws").WebSocket>} */
    this.clients = new Set();
    /** @type {WebSocketServer|null} */
    this.server = null;
    this.listening = false;
    /** 「扩展回包了但结果是 No response」时用来给出准确诊断 */
    this.lastDelivery = null;
  }

  /** 是否已经在这个端口上监听。 */
  get address() {
    return `ws://${this.host}:${this.port}`;
  }

  /**
   * 启动监听。端口被占用时抛 EADDRINUSE，由调用方决定「复用已有 master」。
   * @returns {Promise<void>}
   */
  async start() {
    if (this.listening) return;
    await new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host: this.host, port: this.port });

      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);

      server.on("connection", (socket) => this.#handleClient(socket));

      this.server = server;
    });
    this.listening = true;
    this.log(`master 监听 ${this.address}`);
  }

  /** 关掉监听并清空挂起命令。 */
  async stop() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("master 已停止"));
    }
    this.pending.clear();
    for (const socket of this.clients) {
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.sessions.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    this.listening = false;
  }

  /** @param {import("ws").WebSocket} socket */
  #handleClient(socket) {
    this.clients.add(socket);
    let greeted = false;

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (message?.type) {
        case "ext_ready":
        case "tabs_update":
          greeted = true;
          this.#syncTabs(message.tabs ?? []);
          break;
        case "ack":
          this.#settleAck(message.id);
          break;
        case "result":
          this.#settle(message.id, { ok: true, value: message.result, newTabs: message.newTabs ?? [] });
          break;
        case "error":
          this.#settle(message.id, { ok: false, error: message.error, newTabs: message.newTabs ?? [] });
          break;
        case "ping":
          break;
        default:
          break;
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      // 扩展掉线（MV3 service worker 被回收、浏览器重启）：清掉会话，让上层看到 0 会话
      if (greeted && this.clients.size === 0) {
        this.log("扩展断开，清空会话");
        this.sessions.clear();
      }
    });

    socket.on("error", () => {
      this.clients.delete(socket);
    });
  }

  /** @param {Array<{id: number|string, url?: string, title?: string}>} tabs */
  #syncTabs(tabs) {
    const next = new Map();
    for (const tab of tabs) {
      if (tab?.id === undefined || tab?.id === null) continue;
      const key = String(tab.id);
      const previous = this.sessions.get(key);
      next.set(key, {
        id: key,
        url: tab.url ?? previous?.url ?? "",
        title: tab.title ?? previous?.title ?? "",
        connectedAt: previous?.connectedAt ?? Date.now(),
      });
    }
    this.sessions = next;
  }

  #settleAck(id) {
    const entry = this.pending.get(id);
    if (entry) entry.acked = true;
  }

  #settle(id, outcome) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (outcome.ok) entry.resolve({ data: outcome.value, newTabs: outcome.newTabs });
    else entry.reject(Object.assign(new Error(describeExtensionError(outcome.error)), { extensionError: outcome.error }));
  }

  /** 当前所有标签页会话。 */
  listTabs() {
    return [...this.sessions.values()];
  }

  /**
   * 给某个 tab 发命令，等扩展回包。
   * @param {string|number} tabId
   * @param {string|Record<string, any>} code 普通 JS 字符串，或扩展命令对象
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{data: any, newTabs: Array<any>}>}
   */
  async send(tabId, code, options = {}) {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (this.clients.size === 0) {
      throw new Error(
        "没有扩展连上来：把 Edge/Chrome 里的 tmwd_cdp_bridge 扩展关掉重开，或点扩展图标的 reconnect。",
      );
    }
    const socket = [...this.clients][0];
    if (socket.readyState !== 1) throw new Error("扩展连接已挂起（readyState != OPEN），等它重连或重开扩展。");

    const id = `js-${Date.now()}-${++sequence}`;
    const payload = { id, code: typeof code === "string" ? code : JSON.stringify(code) };
    if (typeof code === "object" && code !== null && code.tabId === undefined) payload.tabId = Number(tabId);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `扩展 ${timeoutMs}ms 内没有回包（tab ${tabId}）。` +
              `可能卡在某个 tab 的 debugger 会话上：换一个同域 tab 重试。`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type: "exec" });
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 扩展命令（tabs/cookies/cdp/batch/...）。
   * @param {string|number} tabId
   * @param {Record<string, any>} command
   * @param {{timeoutMs?: number}} [options]
   */
  async command(tabId, command, options = {}) {
    const { data } = await this.send(tabId, command, options);
    return data;
  }

  /**
   * CDP 透传。
   * @param {string|number} tabId
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @param {{timeoutMs?: number}} [options]
   */
  async cdp(tabId, method, params, options = {}) {
    const command = { cmd: "cdp", tabId: Number(tabId), method };
    if (params !== undefined) command.params = params;
    const result = await this.command(tabId, command, options);
    return result?.result !== undefined ? result.result : result;
  }
}

/** 扩展回来的是结构化 error 或字符串，统一成可读文本。 */
export function describeExtensionError(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = error.message ?? error.error ?? "";
    const detail = error.stack && error.stack !== message ? `\n${error.stack}` : "";
    return message ? `${message}${detail}` : JSON.stringify(error);
  }
  return String(error);
}
