/**
 * 宿主半的接口测试：不启动 dsh，直接用一个假 ctx 抓取路由 handler，再用假
 * req/res 打它。覆盖围栏、信封、方法分发，以及 probe 的真实 HTTP 往返。
 *
 * 运行：`node --test`。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createServer } from "node:http";

import {
  API_PATH,
  PortManagerApiError,
  apply,
  inject,
  isTrustedRequest,
  readJsonBody,
  writeError,
  writeJson,
  writeOk,
} from "../lib/index.js";

/** 造一个可当 req 用的假请求。 */
function fakeRequest({ method = "POST", url = `${API_PATH}/list`, host = "127.0.0.1:3080", origin, secFetchSite, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  stream.headers = { host };
  if (origin !== undefined) stream.headers.origin = origin;
  if (secFetchSite !== undefined) stream.headers["sec-fetch-site"] = secFetchSite;
  return stream;
}

/** 造一个记录状态码与响应体的假 res。 */
function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ?? "";
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

/** 捕获插件注册的路由。 */
function captureRoute() {
  let route = null;
  const ctx = {
    get: () => undefined,
    effect: (factory) => {
      factory();
      return () => {};
    },
    webServer: {
      register(candidate) {
        route = candidate;
        return () => {};
      },
    },
  };
  apply(ctx);
  assert.notEqual(route, null, "插件没有注册路由");
  assert.equal(route.kind, "prefix");
  assert.equal(route.path, API_PATH);
  return route;
}

// ── 围栏 ────────────────────────────────────────────────────────────────────

test("isTrustedRequest：只有 loopback / 可信主机 + 同源才放行", () => {
  assert.equal(isTrustedRequest(fakeRequest(), []), true);
  assert.equal(isTrustedRequest(fakeRequest({ host: "localhost:3080" }), []), true);
  assert.equal(isTrustedRequest(fakeRequest({ origin: "http://127.0.0.1:3080" }), []), true);
  assert.equal(isTrustedRequest(fakeRequest({ origin: "http://evil.example" }), []), false);
  assert.equal(isTrustedRequest(fakeRequest({ secFetchSite: "cross-site" }), []), false);
  assert.equal(isTrustedRequest(fakeRequest({ host: "192.168.0.100:3080" }), []), false);
  assert.equal(isTrustedRequest(fakeRequest({ host: "192.168.0.100:3080" }), ["192.168.0.100:3080"]), true);
  assert.equal(isTrustedRequest({ headers: {} }, []), false);
});

test("信封：ok / error 的形状固定", () => {
  const ok = fakeResponse();
  writeOk(ok, { ports: [] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { ok: true, value: { ports: [] } });

  const bad = fakeResponse();
  writeError(bad, new PortManagerApiError("bad-request", "参数不对", 400));
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json(), { ok: false, error: { code: "bad-request", message: "参数不对" } });

  const boom = fakeResponse();
  writeError(boom, new Error("炸了"));
  assert.equal(boom.status, 500);
  assert.equal(boom.json().error.code, "internal");

  const raw = fakeResponse();
  writeJson(raw, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
  assert.equal(raw.headers["content-type"], "application/json; charset=utf-8");
});

test("readJsonBody：空体当 {}、坏 JSON 报 400、超大拒绝", async () => {
  assert.deepEqual(await readJsonBody(fakeRequest({ body: undefined })), {});
  assert.deepEqual(await readJsonBody(fakeRequest({ body: { pid: 1 } })), { pid: 1 });
  await assert.rejects(() => readJsonBody(fakeRequest({ body: "{not json" })), (error) => {
    assert.ok(error instanceof PortManagerApiError);
    assert.equal(error.code, "bad-request");
    return true;
  });
  await assert.rejects(() => readJsonBody(fakeRequest({ body: `"${"x".repeat(1 << 21)}"` })), (error) => error.code === "bad-request");
});

test("插件导出：零依赖对象插件 + inject webServer", () => {
  assert.equal(typeof apply, "function");
  assert.deepEqual(inject, ["webServer"]);
});

// ── 路由 ────────────────────────────────────────────────────────────────────

test("路由：GET 405、未知方法 404、跨站 403", async () => {
  const route = captureRoute();

  const get = fakeResponse();
  await route.handler(fakeRequest({ method: "GET" }), get);
  assert.equal(get.status, 405);

  const unknown = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/nope`, body: {} }), unknown);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().error.code, "not-found");

  const nested = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/a/b`, body: {} }), nested);
  assert.equal(nested.status, 404);

  const foreign = fakeResponse();
  await route.handler(fakeRequest({ host: "evil.example", body: {} }), foreign);
  assert.equal(foreign.status, 403);

  const crossSite = fakeResponse();
  await route.handler(fakeRequest({ secFetchSite: "cross-site", body: {} }), crossSite);
  assert.equal(crossSite.status, 403);
});

test("路由 list：返回端口、统计与自身端口", async () => {
  const route = captureRoute();
  const res = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/list`, body: { force: true } }), res);
  assert.equal(res.status, 200);
  const value = res.json().value;
  assert.ok(Array.isArray(value.ports), "list 必须返回 ports 数组");
  assert.equal(typeof value.stats.ports, "number");
  assert.equal(value.selfPort, 3080);
  for (const entry of value.ports) {
    assert.equal(typeof entry.port, "number");
    assert.equal(typeof entry.app.title, "string");
    assert.equal(typeof entry.killable, "boolean");
    assert.ok(Array.isArray(entry.bindings));
  }
});

test("路由 kill：不在监听的 pid 拒绝，参数非法拒绝", async () => {
  const route = captureRoute();

  const badPid = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/kill`, body: { pid: "abc", port: 1 } }), badPid);
  assert.equal(badPid.status, 400);

  const notListening = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/kill`, body: { pid: 999999, port: 1 } }), notListening);
  assert.ok([403, 409].includes(notListening.status), `期望 403/409，实际 ${notListening.status}`);
  assert.ok(["not-listening", "refused", "not-found"].includes(notListening.json().error.code));

  const missingPort = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/kill`, body: { pid: 999999 } }), missingPort);
  assert.equal(missingPort.status, 400);
});

test("路由 detail / reveal：找不到就 404", async () => {
  const route = captureRoute();

  const detail = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/detail`, body: { pid: 999999 } }), detail);
  assert.equal(detail.status, 404);

  const reveal = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/reveal`, body: { path: "/definitely/not/here" } }), reveal);
  assert.equal(reveal.status, 404);

  const open = fakeResponse();
  await route.handler(fakeRequest({ url: `${API_PATH}/open`, body: { port: 0 } }), open);
  assert.equal(open.status, 400);
});

test("路由 probe：对真实本地 HTTP 服务返回状态码与标题", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", server: "pgm-test" });
    res.end("<html><head><title>端口探测测试</title></head><body>ok</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const route = captureRoute();
    const res = fakeResponse();
    await route.handler(fakeRequest({ url: `${API_PATH}/probe`, body: { port, scheme: "http" } }), res);
    assert.equal(res.status, 200);
    const value = res.json().value;
    assert.equal(value.ok, true);
    assert.equal(value.status, 200);
    assert.equal(value.title, "端口探测测试");
    assert.equal(value.headers.server, "pgm-test");
    assert.equal(value.tls, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
