/**
 * 自测：不需要启动 DSH。
 *
 *  1. 纯函数：NDJSON 解析、异步状态机、配置校验；
 *  2. 用真 DSH 的 @deepseek-ai/dsh-tools 校验 5 个工具的 schema 能被 defineTool 接受；
 *  3. 对着真跑的 TMWebDriver master 跑一遍（列会话 / eval / Promise 轮询 / cookie / localStorage）。
 *
 * 用法：node test/smoke.mjs [目标URL子串]
 * 需要能 import @deepseek-ai/dsh-tools；找不到时用 DSH_TOOLS_PATH 指过去。
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DSH_TOOLS_CANDIDATES = [
  process.env.DSH_TOOLS_PATH,
  "/tmp/dshx/full/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js",
].filter(Boolean);
const dshToolsPath = DSH_TOOLS_CANDIDATES.find((candidate) => existsSync(candidate));
if (!dshToolsPath) {
  console.error("找不到 @deepseek-ai/dsh-tools：设置 DSH_TOOLS_PATH=/path/to/lib/index.js");
  process.exit(2);
}
const dshTools = await import(pathToFileURL(dshToolsPath).href);
const { assertSupportedJsonSchema, assertObjectJsonSchema } = dshTools;

const { resolveConfig, apply } = await import("../src/index.js");
const {
  Bridge,
  parseLinkBody,
  resolvePython,
  requestedCandidates,
  readAsyncResult,
  spawnFailureError,
  spawnSafely,
  wrapAsyncEvaluation,
} = await import("../src/bridge.js");

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// ── 1. 纯函数 ────────────────────────────────────────────────────────────────
check("parseLinkBody 忽略前导 ok 行", JSON.stringify(parseLinkBody('ok\n{"ok":1}')) === '{"ok":1}');
check("parseLinkBody 非 JSON 时抛错", throws(() => parseLinkBody("hello")));
const okState = readAsyncResult("OK42", "k");
check("readAsyncResult OK", okState.state === "OK" && okState.value === "42", JSON.stringify(okState));
check("readAsyncResult ERR", readAsyncResult("ERRboom", "k").state === "ERR");
check("readAsyncResult PENDING", readAsyncResult("PENDING", "k").state === "PENDING");
const wrapped = wrapAsyncEvaluation("fetch('/x')", "__o");
check("wrapAsyncEvaluation 生成窗口状态机", wrapped.includes("PENDING") && wrapped.includes("__o"));
// self 模式（默认）下 port 就是 WS 端口语义之外的东西，只有 external 才要求
// port 是 HTTP 端口；把 WS 端口填进 external 的 port 会撞车。
check(
  "external 模式拒绝把 WS 端口当 HTTP 端口",
  throws(() => resolveConfig({ mode: "external", port: 18765 })),
);
check(
  "self 模式允许 port: 18765（那是 wsPort 的邻居）",
  resolveConfig({ port: 18765 }).mode === "self",
);
check("resolveConfig 缺省值", resolveConfig({}).port === 18766 && resolveConfig({}).mode === "self");
check("resolveConfig 默认 wsPort", resolveConfig({}).wsPort === 18765);

// ── 1b. Windows 解释器解析 + spawn 安全（回归：曾导致 host 崩溃） ──────────
check(
  "win32: python3 → python（存在 python 时）",
  resolvePython("python3", { platform: "win32", exists: (p) => p === "python" }) === "python",
);
check(
  "win32: python3 → py（只装了 py launcher）",
  resolvePython("python3", { platform: "win32", exists: (p) => p === "py" }) === "py",
);
check("win32: 绝对路径不覆盖", resolvePython("C:/Python312/python.exe", { platform: "win32" }) === "C:/Python312/python.exe");
check("posix: python3 原样", resolvePython("python3", { platform: "darwin" }) === "python3");
check("候选清单非空", requestedCandidates("python3").length > 0);
check(
  "ENOENT 错误文案可执行",
  spawnFailureError("python", { code: "ENOENT" }, "python3").message.includes("pythonPath"),
);

// 核心回归：spawn 一个不存在的解释器，必须由 failure 接住，不能抛出未捕获异常
const missing = spawnSafely("dsh-browser-bridge-no-such-python", ["-c", "print(1)"], { stdio: "ignore" });
const spawnError = await missing.failure;
check("spawnSafely 接住 ENOENT", spawnError?.code === "ENOENT", spawnError?.code);
missing.child.unref?.();

// host 不能崩：ensure() 遇到不存在的解释器只返回错误，不抛未捕获事件
{
  const broken = new Bridge({ autoStart: true, port: 59999, pythonPath: "dsh-no-such-python-xyz", genericAgentDir: "/tmp" });
  const message = await broken.ensure({ startTimeoutMs: 2500 }).then(
    () => "UNEXPECTED-OK",
    (error) => error.message,
  );
  check(
    "ensure() 解释器不存在时进程存活且报错可读",
    message.includes("pythonPath") && !message.includes("UNEXPECTED"),
    message.slice(0, 70),
  );
}

// ── 2. 工具 schema 能被 DSH 的 defineTool 接受 ──────────────────────────────
const registered = new Map();
const promptSections = new Map();
const fakeCtx = {
  tools: {
    register: (tool) => {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
    get: (toolName) => registered.get(toolName),
  },
  systemPrompt: {
    section: (section) => {
      promptSections.set(section.name, section);
      return () => promptSections.delete(section.name);
    },
    getSectionOrder: () => 2101,
  },
  provide: (svcName, value) => {
    fakeCtx[svcName] = value;
  },
  // 插件用 ctx.get("systemPrompt") 拿可选服务（cordis 代理在没 inject 时读它会抛）
  get: (svcName) => (svcName === "systemPrompt" ? fakeCtx.systemPrompt : undefined),
  on: () => () => {},
  logger: { info: () => {} },
};

apply(fakeCtx, { autoStart: false });
check("注册了 5 个工具", registered.size === 5, [...registered.keys()].join(","));
for (const [toolName, tool] of registered) {
  // apply() 里已经过 defineTool 编译（parameters/output 是编译后的 JSON Schema）；
  // 这里对编译产物再跑一次 DSH 自己的 schema 断言，确保运行期不会被拒。
  let accepted = false;
  let detail;
  try {
    assertSupportedJsonSchema(tool.parameters);
    assertObjectJsonSchema(tool.output.schema);
    accepted = tool.parameters.type === "object" && typeof tool.name === "string" && typeof tool.execute === "function";
    detail = `${Object.keys(tool.parameters.properties ?? {}).join(",") || "no-args"}`;
  } catch (error) {
    detail = error.message;
  }
  check(`DSH schema 接受 ${toolName}`, accepted, detail);
}
check("系统提示段注册", promptSections.has("tool:BROWSER"));
check("browserBridge 服务暴露", Boolean(fakeCtx.browserBridge));

// ── 3. 真桥：列会话 + eval ──────────────────────────────────────────────────
const bridge = new Bridge({ autoStart: false });
if (!(await bridge.isAlive())) {
  console.log("\nSKIP  真桥测试（TMWebDriver 18766 没在监听）");
} else {
  const sessions = await bridge.sessions();
  check("get_all_sessions", Array.isArray(sessions) && sessions.length > 0, `${sessions.length} 个`);
  const preferred = process.argv[2]
    ? sessions.filter((session) => String(session.url ?? "").includes(process.argv[2]))
    : [];
  const ordered = [...preferred, ...sessions.filter((session) => !preferred.includes(session))];

  let tab;
  let evaluated;
  for (const candidate of ordered.slice(0, 8)) {
    try {
      const value = await bridge.evaluate(candidate.id, "1+1", { timeoutMs: 15_000 });
      if (value === 2) {
        tab = candidate;
        evaluated = value;
        break;
      }
    } catch {
      /* 这个 tab 的扩展没回包，换下一个 */
    }
  }
  const diagnosis = await bridge.diagnose();
  if (evaluated === 2) {
    check("Runtime.evaluate 1+1", true, `tab ${tab.id} @ ${String(tab.url).slice(0, 60)}`);
  } else {
    // 不算插件缺陷：取决于扩展此刻有没有回包。明确说出来，别静默跳过。
    console.log(`WARN  Runtime.evaluate 1+1  — 扩展未回包（${diagnosis.hint}）`);
    console.log("      修好扩展后重跑：node test/smoke.mjs <URL子串>");
  }

  if (tab) {
    const title = await bridge.evaluate(tab.id, "document.title");
    check("读 document.title", typeof title === "string", String(title).slice(0, 60));

    const asyncValue = await bridge.runJs(
      tab.id,
      "new Promise((resolve) => setTimeout(() => resolve({ok: true, origin: location.origin}), 300))",
      { timeoutMs: 20_000, pollMs: 200 },
    );
    check("runJs 轮询 Promise", asyncValue.value?.ok === true, JSON.stringify(asyncValue.value));

    const errorRun = await bridge
      .runJs(tab.id, "throw new Error('boom')", { timeoutMs: 10_000 })
      .then(() => null)
      .catch((error) => error.message);
    check("runJs 把页面异常抛回来", typeof errorRun === "string" && errorRun.includes("boom"), errorRun);

    const origin = `${new URL(String(tab.url)).origin}/`;
    const cookies = await bridge.cookies(tab.id, [origin]);
    check(
      "Network.getCookies",
      Array.isArray(cookies),
      `${cookies.length} 条，HttpOnly ${cookies.filter((cookie) => cookie.httpOnly).length}`,
    );

    const storage = await bridge.localStorage(tab.id);
    check("localStorage 直出", typeof storage === "object" && storage !== null, `${Object.keys(storage).length} keys`);

    // 端到端走工具层（schema 校验 + 渲染）
    const tabsTool = registered.get("browser_tabs");
    const evalTool = registered.get("browser_eval");
    const cookieTool = registered.get("browser_cookie");
    const tabsValue = await tabsTool.execute({ url_contains: process.argv[2] ?? undefined });
    check("browser_tabs.execute", tabsValue.count > 0 && tabsValue.sessions[0].tabId > 0, `${tabsValue.count} 个`);
    const evalValue = await evalTool.execute({ tab_id: Number(tab.id), js: "location.origin" });
    check("browser_eval.execute", evalValue.value === origin.slice(0, -1), evalValue.value);
    const cookieValue = await cookieTool.execute({ tab_id: Number(tab.id), url: origin, mask: true });
    check(
      "browser_cookie.execute 打码",
      cookieValue.cookies.every((cookie) => cookie.value === "" || /^<len \d+>$/.test(cookie.value)),
      `count ${cookieValue.count}`,
    );
    console.log(`\n  browser_tabs 渲染样例：\n${tabsValue.rendered.split("\n").slice(0, 4).join("\n")}`);
  }
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
