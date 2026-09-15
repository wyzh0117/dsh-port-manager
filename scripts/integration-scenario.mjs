/**
 * 集成场景（子进程脚本，不是测试文件本身）：起真的 cordis Context + 真的
 * `@deepseek-ai/dsh-host-webserver`，用真的 HTTP 请求打插件注册的前缀路由。
 *
 * 为什么放在子进程里跑：webServer 会一直持有监听 socket，主测试进程即使断言失败也
 * 不会退出。让这个脚本自己 `process.exit`，由 integration.test.mjs 校验退出码与输出。
 *
 * 成功时在最后打印 `INTEGRATION OK`。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

import { API_PATH, apply } from "../lib/index.js";

/** 候选的 profile node_modules。 */
const RUNTIME_ROOTS = [
  process.env.DSH_RUNTIME_ROOT,
  "/Users/youngi/.dsh/profiles/node_modules",
  "/Users/youngi/.dsh/profiles/web/node_modules",
].filter((entry) => typeof entry === "string" && entry !== "");

/**
 * 解析 dsh 运行时依赖。
 * @returns {{cordis:string, webserver:string}|null} 解析结果。
 */
function resolveRuntime() {
  for (const root of RUNTIME_ROOTS) {
    if (!existsSync(`${root}/@deepseek-ai/cordis/package.json`)) continue;
    try {
      const req = createRequire(`${root}/index.js`);
      return { cordis: req.resolve("@deepseek-ai/cordis"), webserver: req.resolve("@deepseek-ai/dsh-host-webserver") };
    } catch {
      // 换下一个候选。
    }
  }
  return null;
}

/**
 * 发一个真实 HTTP 请求。
 * @param {number} port - 监听端口。
 * @param {string} path - 路径。
 * @param {{method?:string, host?:string, origin?:string, body?:object, secFetchSite?:string}} [options] - 请求选项。
 * @returns {Promise<{status:number, json:object|null}>} 响应。
 */
function call(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const headers = { host: options.host ?? `127.0.0.1:${port}` };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (options.origin !== undefined) headers.origin = options.origin;
    if (options.secFetchSite !== undefined) headers["sec-fetch-site"] = options.secFetchSite;
    const req = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "POST", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const runtime = resolveRuntime();
if (runtime === null) {
  console.log("INTEGRATION SKIP no cordis");
  process.exit(0);
}

try {
  const { Context } = await import(runtime.cordis);
  const { default: WebServer } = await import(runtime.webserver);
  const ctx = new Context();
  await ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  const port = ctx.webServer.port;
  assert.ok(Number.isInteger(port) && port > 0, "webServer 没有拿到监听端口");

  // 插件本体挂进真实服务树：inject: ["webServer"] 由 cordis 满足。
  await ctx.plugin({ name: "dsh-port-manager", inject: ["webServer"], apply });

  const list = await call(port, `${API_PATH}/list`, { body: { force: true } });
  assert.equal(list.status, 200, "list 应返回 200");
  assert.equal(list.json.ok, true);
  const value = list.json.value;
  assert.ok(Array.isArray(value.ports) && value.ports.length > 0, "真实扫描没有返回任何端口");
  assert.equal(value.stats.ports, value.ports.length);
  assert.equal(value.selfPort, port, "selfPort 应该识别出当前监听端口");
  for (const entry of value.ports) {
    assert.equal(typeof entry.port, "number");
    assert.equal(typeof entry.app.title, "string");
    assert.ok(entry.app.title.length > 0, "每个端口都要能报出应用名");
    assert.ok(Array.isArray(entry.bindings) && entry.bindings.length > 0, "每个端口都要有绑定信息");
    assert.equal(typeof entry.killable, "boolean");
  }
  const own = value.ports.find((entry) => entry.port === port);
  assert.notEqual(own, undefined, "自己监听的端口应该出现在列表里");
  assert.equal(own.protected, true, "DSH 自己监听的端口必须受保护");
  assert.equal(own.killable, false);

  // 围栏。
  assert.equal((await call(port, `${API_PATH}/list`, { host: "evil.example", body: {} })).status, 403, "非 loopback Host 必须 403");
  assert.equal((await call(port, `${API_PATH}/list`, { origin: "http://evil.example", body: {} })).status, 403, "异源 Origin 必须 403");
  assert.equal((await call(port, `${API_PATH}/list`, { secFetchSite: "cross-site", body: {} })).status, 403, "跨站必须 403");
  assert.equal((await call(port, `${API_PATH}/list`, { origin: `http://127.0.0.1:${port}`, body: {} })).status, 200, "同源必须放行");

  // 方法与方法名。
  assert.equal((await call(port, `${API_PATH}/list`, { method: "GET" })).status, 405);
  assert.equal((await call(port, `${API_PATH}/nope`, { body: {} })).status, 404);
  assert.equal((await call(port, `${API_PATH}/a/b`, { body: {} })).status, 404);

  // kill 的安全兜底：不存在的 pid 拒绝、参数缺失 400。
  const kill = await call(port, `${API_PATH}/kill`, { body: { pid: 999999, port: 1 } });
  assert.ok([403, 409].includes(kill.status), `kill 期望 403/409，实际 ${kill.status}`);
  assert.equal((await call(port, `${API_PATH}/kill`, { body: { pid: 999999 } })).status, 400);

  // detail / reveal / open 的入参校验。
  assert.equal((await call(port, `${API_PATH}/detail`, { body: { pid: 999999 } })).status, 404);
  assert.equal((await call(port, `${API_PATH}/reveal`, { body: { path: "/definitely/not/here" } })).status, 404);
  assert.equal((await call(port, `${API_PATH}/open`, { body: { port: 0 } })).status, 400);

  console.log(`INTEGRATION OK ports=${value.ports.length} selfPort=${port} source=${value.source}`);
} catch (error) {
  console.error("INTEGRATION FAIL");
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
process.exit(0);

// 引用一次，避免 lint 认为未使用。
void fileURLToPath;
