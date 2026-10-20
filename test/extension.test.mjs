/**
 * 扩展的静态检查 + 与插件 JS master 的协议一致性检查。
 *
 *  1. manifest 合法性：MV3、版本、所有被引用的文件确实存在、图标尺寸对得上
 *  2. 脚本语法
 *  3. 协议对齐：扩展发的类型 / 插件认的类型必须一一对上（这是最容易静默坏掉的地方）
 *  4. 端口一致性：扩展连的 WS 端口 = 插件默认的 wsPort
 *
 * 用法：node test/extension.test.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(here, "..", "extension");
const srcDir = path.join(here, "..", "src");

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const read = (rel) => readFileSync(path.join(extDir, rel), "utf8");

// ── 1. manifest ────────────────────────────────────────────────────────────
const manifest = JSON.parse(read("manifest.json"));
check("manifest 是 MV3", manifest.manifest_version === 3);
check("版本号合法", /^\d+\.\d+(\.\d+)?$/.test(manifest.version), manifest.version);
check("有名称与描述", Boolean(manifest.name && manifest.description));

const referenced = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.css ?? []),
].filter(Boolean));

const missing = [...referenced].filter((rel) => !existsSync(path.join(extDir, rel)));
check("manifest 引用的文件都存在", missing.length === 0, missing.join(", ") || `${referenced.size} 个`);

check(
  "action 配了图标（否则工具栏是灰块）",
  Boolean(manifest.action?.default_icon && Object.keys(manifest.action.default_icon).length > 0),
);
check(
  "icons 声明了 128（商店/详情页要求）",
  Boolean(manifest.icons?.["128"]),
);
check(
  "权限包含 debugger（CDP 透传的前提）",
  (manifest.permissions ?? []).includes("debugger"),
);
check(
  "权限包含 scripting 与 tabs",
  ["scripting", "tabs"].every((p) => (manifest.permissions ?? []).includes(p)),
);

// 图标必须是真 PNG，且尺寸与键名一致
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
let iconsOk = true;
const iconDetails = [];
for (const [size, rel] of Object.entries(manifest.icons ?? {})) {
  const file = path.join(extDir, rel);
  if (!existsSync(file)) {
    iconsOk = false;
    iconDetails.push(`${size} 缺失`);
    continue;
  }
  const buf = readFileSync(file);
  const isPng = buf.subarray(0, 4).equals(PNG_MAGIC);
  const width = buf.length > 24 ? buf.readUInt32BE(16) : 0;
  const height = buf.length > 24 ? buf.readUInt32BE(20) : 0;
  if (!isPng || width !== Number(size) || height !== Number(size)) {
    iconsOk = false;
    iconDetails.push(`${size}: png=${isPng} ${width}x${height}`);
  }
}
check("图标是真 PNG 且尺寸匹配", iconsOk, iconDetails.join(", ") || "全部正确");

// ── 2. 语法 ────────────────────────────────────────────────────────────────
const { spawnSync } = await import("node:child_process");
for (const rel of [...referenced].filter((item) => item.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", path.join(extDir, rel)], { encoding: "utf8" });
  check(`语法通过 ${rel}`, result.status === 0, result.stderr?.split("\n")[0]);
}

// ── 3. 协议对齐 ────────────────────────────────────────────────────────────
const background = read("background.js");
const master = readFileSync(path.join(srcDir, "js-master.js"), "utf8");

// 扩展「发出」的消息类型
const sentTypes = new Set(
  [...background.matchAll(/ws\.send\(\s*JSON\.stringify\(\{\s*type:\s*'([a-z_]+)'/g)].map((m) => m[1]),
);
for (const type of ["ext_ready", "tabs_update", "ack", "result", "error"]) {
  check(`扩展会发 ${type}`, sentTypes.has(type), [...sentTypes].join(","));
}

// 插件「接收」的分支
const handled = new Set([...master.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]));
const unhandled = [...sentTypes].filter((type) => type !== "ping" && !handled.has(type));
check("插件处理了扩展发出的全部类型", unhandled.length === 0, unhandled.join(",") || [...sentTypes].join(","));

// 扩展发送的字段名必须和插件读的一致
const masterReads = ["message.tabs", "message.id", "message.result", "message.error", "message.type"];
const wrongField = masterReads.filter((field) => {
  const key = field.split(".")[1];
  return !new RegExp(`\\b${key}:`).test(background);
});
check(
  "字段名一致（type/tabs/id/result/error）",
  wrongField.length === 0,
  wrongField.join(",") || masterReads.join(","),
);

// ── 4. 端口一致 ────────────────────────────────────────────────────────────
const wsUrl = background.match(/const WS_URL = '(ws:\/\/[^']+)'/)?.[1];
check("扩展里写死了 WS_URL", Boolean(wsUrl), wsUrl);
const port = wsUrl ? Number(new URL(wsUrl).port) : 0;
const masterPort = Number(master.match(/export const DEFAULT_WS_PORT = (\d+)/)?.[1]);
const indexSrc = readFileSync(path.join(srcDir, "index.js"), "utf8");
const configPort = Number(indexSrc.match(/wsPort: z\.number\(\)\.default\((\d+)\)/)?.[1]);
const patchPort = Number(
  readFileSync(path.join(here, "..", "cordis.patch.yml"), "utf8").match(/wsPort:\s*(\d+)/)?.[1],
);
check(
  "端口三处一致（扩展 / JS master / 插件默认值）",
  port === masterPort && port === configPort && port === patchPort,
  `扩展=${port} master=${masterPort} config=${configPort} patch=${patchPort}`,
);

// ── 5. 扩展与插件握手的最小可用性 ──────────────────────────────────────────
// 用 fake 扩展按 background.js 的真实报文格式连一次，确认插件能吃下
const { JsMaster } = await import("../src/js-master.js");
const { WebSocket } = await import("ws");
const probePort = 18866;
const server = new JsMaster({ port: probePort });
await server.start();
const socket = new WebSocket(`ws://127.0.0.1:${probePort}`);
await new Promise((resolve) => socket.on("open", resolve));
socket.send(
  JSON.stringify({ type: "ext_ready", tabs: [{ id: 7, url: "https://ext.example/", title: "Ext" }] }),
);
const deadline = Date.now() + 2000;
while (Date.now() < deadline && server.listTabs().length === 0) {
  await new Promise((r) => setTimeout(r, 20));
}
check("按扩展报文格式握手成功", server.listTabs().length === 1, JSON.stringify(server.listTabs()));
socket.close();
await server.stop();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
