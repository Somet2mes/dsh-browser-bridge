/**
 * 跑全部测试。文件名不统一（smoke.mjs vs *.test.mjs），所以在这里显式列出，
 * 免得像 `for t in extension js-master smoke; node test/$t.test.mjs` 那样
 * 在 smoke 上打成 smoke.test.mjs 而静默失败。
 *
 * 用法：node test/all.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ["extension.test.mjs", "js-master.test.mjs", "smoke.mjs"];

let failed = 0;
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(here, suite)], { encoding: "utf8" });
  const passes = (result.stdout.match(/^PASS/gm) ?? []).length;
  const fails = (result.stdout.match(/^FAIL/gm) ?? []).length;
  const ok = result.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${suite.padEnd(22)} ${passes} 项通过${fails ? `，${fails} 项失败` : ""}`);
  if (!ok) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-15).join("\n");
    console.log(detail.replace(/^/gm, "    "));
  }
}
console.log(failed === 0 ? "\n全部测试通过" : `\n${failed} 个测试文件失败`);
process.exit(failed === 0 ? 0 : 1);
