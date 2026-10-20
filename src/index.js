/**
 * dsh-browser-bridge：把 browser-cdp-control skill 升级成 DSH 一级插件。
 *
 * 区别（skill 版本 vs 这里）：
 *   - skill：每次都要 agent 读 Markdown、自己拼 Python 片段、自己起 master；
 *   - 插件：`browser_tabs / browser_eval / browser_cookie / browser_navigate /
 *     browser_install` 五个工具常驻，schema 校验 + 轮询 + 打码 + 截断都是确定的。
 *
 * 传输：直连 TMWebDriver master 的 HTTP 18766 /link（Node 原生 fetch），
 * 不再需要 GenericAgent 的 Python 包，也不用 WebSocket。
 */

import z from "@deepseek-ai/schemastery";
import { Bridge } from "./bridge.js";
import {
  BROWSER_PROMPT_TEXT,
  DEFAULT_MAX_OUTPUT_CHARS,
  applyCookieTool,
  applyEvalTool,
  applyInstallTool,
  applyNavigateTool,
  applyTabsTool,
} from "./tools.js";

/** 插件名（loader 诊断用）。 */
export const name = "browser-bridge";

/**
 * 依赖服务。cordis 的 ctx 代理只要读没在 inject 里声明的服务就抛
 * `cannot get property "x" without inject`，所以两个都要列。
 * 列在这里 = 硬依赖（等不到就不激活），这是预期的：没有工具注册表这插件没意义。
 */
export const inject = ["tools", "systemPrompt"];

/**
 * 配置项。cordis 要求插件导出的 `Config` 是 Schemastery schema（它读
 * `Config["~standard"].validate`），纯对象 schema 会在挂载时抛
 * `Cannot read properties of undefined (reading 'validate')`。
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  /**
   * self     = 插件自带纯 JS master（默认；不需要 python / GenericAgent）
   * external = 连已有 Python master 的 HTTP /link（兼容旧部署）
   */
  mode: z.union([z.const("self"), z.const("external")]).default("self"),
  /** external 模式下 master 的 HTTP 端口（WebSocket 端口 + 1）。 */
  port: z.number().default(18766),
  /** WebSocket 端口：self 模式在这里监听（扩展写死的 18765）。 */
  wsPort: z.number().default(18765),
  autoStart: z.boolean().default(true),
  /** 仅 external 模式使用。 */
  pythonPath: z.string().default("python3"),
  /** 仅 external 模式使用：TMWebDriver.py 所在目录。 */
  genericAgentDir: z.string().default("~/mi-work/GenericAgent"),
  startScript: z.string().default(""),
  defaultTabSearch: z.string().default(""),
  maskCookies: z.boolean().default(true),
  maxOutputChars: z.number().default(DEFAULT_MAX_OUTPUT_CHARS),
  callTimeoutMs: z.number().default(60_000),
  pollMs: z.number().default(500),
  promptGuidance: z.boolean().default(true),
});

/** 补齐默认值。 */
export function resolveConfig(config = {}) {
  const resolved = {
    enabled: true,
    host: "127.0.0.1",
    mode: "self",
    port: 18766,
    wsPort: 18765,
    autoStart: true,
    pythonPath: "python3",
    genericAgentDir: "~/mi-work/GenericAgent",
    startScript: "",
    defaultTabSearch: "",
    maskCookies: true,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    callTimeoutMs: 60_000,
    pollMs: 500,
    promptGuidance: true,
    ...config,
  };
  if (resolved.mode !== "self" && resolved.mode !== "external") {
    throw new Error('browser-bridge: mode 只能是 "self" 或 "external"');
  }
  if (resolved.mode === "external" && resolved.port === 18765) {
    throw new Error("browser-bridge: external 模式下 port 要填 HTTP 端口（WS 端口 + 1，默认 18766）");
  }
  for (const key of ["port", "wsPort", "maxOutputChars", "callTimeoutMs", "pollMs"]) {
    if (!Number.isInteger(resolved[key]) || resolved[key] < 1) {
      throw new Error(`browser-bridge: ${key} 必须是正整数`);
    }
  }
  return resolved;
}

/**
 * 插件入口。
 * @param {any} ctx
 * @param {Partial<ReturnType<typeof resolveConfig>>} [config]
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;

  const bridge = new Bridge({
    host: resolved.host,
    mode: resolved.mode,
    port: resolved.mode === "self" ? resolved.wsPort + 1 : resolved.port,
    wsPort: resolved.wsPort,
    autoStart: resolved.autoStart,
    pythonPath: resolved.pythonPath,
    genericAgentDir: resolved.genericAgentDir,
    startScript: resolved.startScript,
    envelopeTimeoutMs: resolved.callTimeoutMs + 5_000,
    log: (message) => ctx.logger?.info?.(`[browser-bridge] ${message}`),
  });

  /**
   * 暴露成 cordis 服务：`browserBridge`。工具层通过它拿连接，
   * 别的插件也能 `ctx.browserBridge.runJs(...)` 复用同一份桥。
   */
  const service = {
    bridge,
    url: bridge.url,
    /** 确保能干活（self 起 JS master / external 确认端口），返回 bridge。 */
    async ensureReady(options) {
      await bridge.ensureReady(options);
      return bridge;
    },
    /** external 模式：拉起 Python master。 */
    async ensure(options) {
      await bridge.ensure(options);
      return bridge;
    },
    get mode() {
      return bridge.mode;
    },
    get masterAddress() {
      return bridge.master?.address ?? bridge.url;
    },
    get extensionConnected() {
      return bridge.hasExtension;
    },
    shutdown: () => bridge.shutdown(),
    /** 默认 tab：defaultTabSearch 命中的第一个，否则最近活动的。 */
    resolveDefaultTab(search) {
      const pattern = search ?? resolved.defaultTabSearch;
      const cached = service._tabs;
      if (!cached) return undefined;
      const picked = bridge.pickTab(cached, pattern);
      return picked ? Number(picked.id) : undefined;
    },
    /** browser_tabs 成功后缓存一份，供默认 tab 选择使用。 */
    rememberSessions(sessions) {
      service._tabs = sessions.map((session) => ({ id: String(session.tabId ?? session.id), url: session.url }));
    },
    sessions: () => bridge.sessions(),
    runJs: (tabId, js, options) => bridge.runJs(String(tabId), js, options),
    evaluate: (tabId, expression, options) => bridge.evaluate(String(tabId), expression, options),
    cookies: (tabId, urls, options) => bridge.cookies(String(tabId), urls, options),
    navigate: (tabId, url, options) => bridge.navigate(String(tabId), url, options),
    batch: (tabId, commands, options) => bridge.batch(String(tabId), commands, options),
    diagnose: () => bridge.diagnose(),
    localStorage: (tabId, options) => bridge.localStorage(String(tabId), options),
  };
  ctx.provide?.("browserBridge", service);

  const limits = {
    maxOutputChars: resolved.maxOutputChars,
    timeoutMs: resolved.callTimeoutMs,
    pollMs: resolved.pollMs,
    defaultTab: resolved.defaultTabSearch,
    maskByDefault: resolved.maskCookies,
  };

  const prompt = ctx.get?.("systemPrompt");
  if (resolved.promptGuidance && prompt?.section) {
    prompt.section({
      name: "tool:BROWSER",
      order: prompt.getSectionOrder?.("TOOL_WEB_FETCH") ?? 2101,
      text: ({ scope }) => (ctx.tools.get("browser_eval", scope) === undefined ? "" : BROWSER_PROMPT_TEXT),
    });
  }

  applyTabsTool(ctx, limits);
  applyEvalTool(ctx, limits);
  applyCookieTool(ctx, limits);
  applyNavigateTool(ctx, limits);
  applyInstallTool(ctx, limits);

  // 卸载插件时必须放掉 18765，否则下次启动会 EADDRINUSE。
  ctx.on?.("dispose", () => {
    service._tabs = undefined;
    void bridge.shutdown();
  });
}

export { Bridge } from "./bridge.js";
export * from "./tools.js";
