/**
 * 纯 JS master 的协议测试：用一个 **模拟扩展** 连上来，验证
 * ext_ready / tabs_update / ack / result / error / ping 全链路，
 * 以及超时、扩展缺位、端口占用这些失败路径。
 *
 * 不碰真实浏览器，可以在任何机器上跑：node test/js-master.test.mjs
 */

import { WebSocket } from "ws";
import { JsMaster } from "../src/js-master.js";

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(30);
  }
  return false;
};

/** 模拟 tmwd_cdp_bridge 扩展：行为与 background.js 对齐。 */
function fakeExtension(port, behaviour) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const received = [];
  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        type: "ext_ready",
        tabs: [
          { id: 101, url: "https://a.example/", title: "A" },
          { id: 102, url: "https://b.example/", title: "B" },
        ],
      }),
    );
  });
  socket.on("message", async (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "ping") return;
    received.push(message);
    const code = typeof message.code === "string" ? JSON.parse(message.code) : message.code;
    await sleep(5);
    socket.send(JSON.stringify({ type: "ack", id: message.id }));
    behaviour(message, code, socket);
  });
  return { socket, received };
}

const PORT = 18865;
const master = new JsMaster({ port: PORT });

// ── 没有扩展时必须给出可操作的错误 ─────────────────────────────────────────
await master.start();
const noExtension = await master.send(1, "1+1", { timeoutMs: 500 }).then(
  () => null,
  (error) => error.message,
);
check("无扩展时 send 报错可读", Boolean(noExtension?.includes("tmwd_cdp_bridge")), noExtension?.slice(0, 60));
check("无扩展时 listTabs 为空", master.listTabs().length === 0);

// ── 扩展连上 + 回包 ────────────────────────────────────────────────────────
const ext = fakeExtension(PORT, (message, code, socket) => {
  if (code.cmd === "cdp") {
    socket.send(
      JSON.stringify({ type: "result", id: message.id, result: { result: { type: "number", value: 2 } }, newTabs: [] }),
    );
    return;
  }
  if (code.cmd === "boom") {
    socket.send(JSON.stringify({ type: "error", id: message.id, error: { name: "Error", message: "kaboom" } }));
    return;
  }
  if (code.cmd === "slow") return; // 故意不回，测超时
  socket.send(JSON.stringify({ type: "result", id: message.id, result: { ok: true }, newTabs: [] }));
});

check("扩展连上", await waitFor(() => master.clients.size === 1), `clients=${master.clients.size}`);
check("收到 ext_ready 的标签页", await waitFor(() => master.listTabs().length === 2), `${master.listTabs().length} 个`);
check(
  "listTabs 内容正确",
  master.listTabs()[0]?.url === "https://a.example/" && master.listTabs()[1]?.id === "102",
);

const evalResult = await master.cdp(101, "Runtime.evaluate", { expression: "1+1", returnByValue: true });
check("CDP 往返", evalResult?.value === 2, JSON.stringify(evalResult));

const commandResult = await master.command(102, { cmd: "tabs" });
check("扩展命令往返", commandResult?.ok === true, JSON.stringify(commandResult));

const extensionError = await master
  .command(101, { cmd: "boom" })
  .then(() => null, (error) => error.message);
check("扩展 error 转成可读错误", extensionError === "kaboom", extensionError);

const timeoutError = await master
  .command(101, { cmd: "slow" }, { timeoutMs: 400 })
  .then(() => null, (error) => error.message);
check("超时报错不提崩溃、给处置建议", Boolean(timeoutError?.includes("换一个同域 tab")), timeoutError?.slice(0, 50));
check("超时后 pending 已清理", master.pending.size === 0, `${master.pending.size}`);

// 扩展发 tabs_update → 会话跟着变
ext.socket.send(
  JSON.stringify({ type: "tabs_update", tabs: [{ id: 101, url: "https://a.example/", title: "A2" }] }),
);
check("tabs_update 覆盖会话", await waitFor(() => master.listTabs().length === 1), `${master.listTabs().length}`);

// ── 扩展断线 → 会话清空，再连回来能恢复 ────────────────────────────────────
ext.socket.close();
check("扩展断线后会话清空", await waitFor(() => master.listTabs().length === 0), `${master.listTabs().length}`);
const ext2 = fakeExtension(PORT, (message, code, socket) => {
  socket.send(JSON.stringify({ type: "result", id: message.id, result: "back", newTabs: [] }));
});
check("扩展重连后恢复", await waitFor(() => master.listTabs().length === 2));
check("重连后可继续下发命令", (await master.command(101, { cmd: "tabs" })) === "back");
ext2.socket.close();
await waitFor(() => master.clients.size === 0);

// ── 端口占用：第二个 master 必须明确报 EADDRINUSE ──────────────────────────
const second = new JsMaster({ port: PORT });
const addressInUse = await second.start().then(
  () => null,
  (error) => error.code,
);
check("端口占用报 EADDRINUSE", addressInUse === "EADDRINUSE", addressInUse);

await master.stop();
check("stop() 关闭监听", master.listening === false && master.clients.size === 0);

// 关掉之后端口要能重新被占用
const reused = new JsMaster({ port: PORT });
let reusedOk = false;
try {
  await reused.start();
  reusedOk = reused.listening;
} catch {
  reusedOk = false;
}
check("stop() 之后端口可复用", reusedOk);
await reused.stop();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
