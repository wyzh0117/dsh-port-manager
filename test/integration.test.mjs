/**
 * 集成测试入口：把真实 cordis + 真实 webServer 的场景放进子进程跑
 * （`scripts/integration-scenario.mjs`），这里只校验退出码与输出。
 *
 * 子进程方案是刻意的：webServer 会一直持有监听 socket，同进程内跑会让测试进程
 * 无法自然退出。找不到 dsh 运行时依赖时跳过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 场景脚本放在 scripts/ 下：test/ 目录里的任何 .mjs 都会被 `node --test` 当测试收集。 */
const SCENARIO = join(HERE, "..", "scripts", "integration-scenario.mjs");

/** 候选的 profile node_modules。 */
const RUNTIME_ROOTS = [
  process.env.DSH_RUNTIME_ROOT,
  "/Users/youngi/.dsh/profiles/node_modules",
  "/Users/youngi/.dsh/profiles/web/node_modules",
].filter((entry) => typeof entry === "string" && entry !== "");

test("真实 cordis + webServer：路由挂载、围栏、信封、真实扫描", (t) => {
  const available = RUNTIME_ROOTS.some((root) => existsSync(`${root}/@deepseek-ai/cordis/package.json`));
  if (!available) return t.skip("本机找不到 @deepseek-ai/cordis，跳过集成测试");

  const result = spawnSync(process.execPath, [SCENARIO], {
    encoding: "utf8",
    timeout: 90_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output.includes("INTEGRATION SKIP")) return t.skip("子进程里也解析不到 cordis");
  assert.equal(result.status, 0, `集成场景失败（exit ${result.status}）：\n${output}`);
  assert.match(output, /INTEGRATION OK/);
  return undefined;
});
