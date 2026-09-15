/**
 * dsh-port-manager — 宿主半（Node 侧）。
 *
 * 提供一条围栏 JSON 路由 `/port-manager/api/<method>`，覆盖浏览器半需要的全部能力：
 *
 *   - list   { includeUdp?, docker?, force? }  本机监听端口 + 占用进程 + 应用名（lsof/ss + ps）
 *   - detail { pid }                           进程完整信息（命令行 / cwd / 父进程链 / 它占用的端口）
 *   - kill   { pid, port, signal? }            结束占用某端口的进程（先校验“它确实还在监听这个端口”）
 *   - open   { port, host?, scheme? }          用系统默认浏览器打开该端口
 *   - reveal { path }                          在访达 / 文件管理器里打开目录
 *   - probe  { port, path? }                   HTTP 探测：状态码、Server、标题、耗时
 *
 * 设计约束（与 dsh 插件生态保持一致）：
 *   - 除同目录的 ./scan.js 外零 import：不引入 `@deepseek-ai/cordis`，因此插件目录
 *     不需要 node_modules，`link:` 安装后即可加载（见 README 的“依赖说明”）；
 *   - 只用 node 内置模块与系统自带命令（lsof / ps / ss / open），无运行时依赖；
 *   - 破坏性操作（kill）先做归属校验，并复用与 `/api` 网关一致的 loopback/同源围栏。
 *
 * @module dsh-port-manager
 */

import { existsSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { runCommand, scanPorts, splitCommand } from "./scan.js";

/** 路由前缀，也是浏览器半调用时的 base。 */
export const API_PATH = "/port-manager/api";

/** 扫描结果缓存时长：自动刷新时避免把 lsof 打满。 */
const SCAN_TTL_MS = 1_200;

/** 请求体上限。 */
const MAX_BODY_BYTES = 1 << 20;

// ── 错误与 wire 助手（与 dsh-skill-select / dsh-pin 同构）────────────────────

/** 带错误码与 HTTP 状态的业务错误。 */
export class PortManagerApiError extends Error {
  /**
   * @param {string} code - 机器可读错误码。
   * @param {string} message - 面向用户的说明。
   * @param {number} [status] - HTTP 状态码。
   */
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * 浏览器信任围栏：只接受 loopback（或 webRuntime 声明的可信主机）发出的同源请求。
 *
 * 与 `/api` 网关、dsh-skill-select、dsh-pin 的判定一致；这段代码是 kill 接口的
 * 唯一门禁，别删。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {string[]} trustedHosts - webRuntime 暴露的可信主机列表。
 * @returns {boolean} 是否可信。
 */
export function isTrustedRequest(req, trustedHosts) {
  const host = req.headers.host;
  if (host === undefined) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const isLoopback = (hostname) => {
    if (hostname === "localhost" || hostname === "[::1]") return true;
    const parts = hostname.split(".");
    return parts.length === 4
      && parts[0] === "127"
      && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  };
  const trusted = (trustedHosts ?? []).some((entry) => {
    try {
      const parsed = new URL(`http://${entry}`);
      const entryPort = parsed.port || new URL(`https://${entry}`).port;
      const hostPort = hostUrl.port || new URL(`https://${host}`).port;
      if (entryPort === "" || hostPort === "") return parsed.hostname === hostUrl.hostname;
      return parsed.host === hostUrl.host;
    } catch {
      return false;
    }
  });
  if (!isLoopback(hostUrl.hostname) && !trusted) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * 读取并解析 JSON 请求体。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @returns {Promise<object>} 解析后的对象。
 */
export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new PortManagerApiError("bad-request", "请求体过大");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new PortManagerApiError("bad-request", "请求体不是合法 JSON");
  }
}

/**
 * 写出 JSON 响应。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {object} body - 响应体。
 * @returns {void}
 */
export function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * 写出成功信封。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @param {object} value - 业务数据。
 * @returns {void}
 */
export function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}

/**
 * 写出错误信封。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @param {unknown} error - 捕获到的错误。
 * @returns {void}
 */
export function writeError(res, error) {
  if (error instanceof PortManagerApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  writeJson(res, 500, {
    ok: false,
    error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
  });
}

/**
 * 取必填整数。
 * @param {object} payload - 请求体。
 * @param {string} key - 字段名。
 * @returns {number} 校验后的整数。
 */
function requireInt(payload, key) {
  const value = payload?.[key];
  const number = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isSafeInteger(number)) throw new PortManagerApiError("bad-request", `${key} 必须是整数`);
  return number;
}

/**
 * 从请求 Host 头推断 DSH 自己监听的端口（用于把“我自己的端口”标成受保护）。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @returns {number|null} 端口号。
 */
function selfPortOf(req) {
  const host = req.headers.host;
  if (typeof host !== "string") return null;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.port !== "") return Number.parseInt(parsed.port, 10);
    return 80;
  } catch {
    return null;
  }
}

// ── 业务实现 ────────────────────────────────────────────────────────────────

/** 扫描缓存：同一参数组合在 TTL 内复用，并发请求共用同一次扫描。 */
class ScanCache {
  constructor() {
    /** @type {Map<string, {at:number, value:object}>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<object>>} */
    this.inflight = new Map();
  }

  /**
   * 取扫描结果（带 TTL 与并发合并）。
   * @param {{includeUdp:boolean, selfPort:number|null, docker:boolean, force?:boolean}} options - 扫描选项。
   * @returns {Promise<object>} 扫描结果。
   */
  async get(options) {
    const key = `${options.includeUdp ? "udp" : "tcp"}:${options.docker ? "docker" : "nodocker"}`;
    const cached = this.entries.get(key);
    if (options.force !== true && cached !== undefined && Date.now() - cached.at < SCAN_TTL_MS) {
      return { ...cached.value, cached: true, selfPort: options.selfPort };
    }
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const task = scanPorts(options)
      .then((value) => {
        this.entries.set(key, { at: Date.now(), value });
        return { ...value, cached: false, selfPort: options.selfPort };
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }
}

/**
 * 校验某个 PID 是否仍然监听指定端口，并确认它属于当前用户。
 *
 * kill 之前必须过这一关：列表可能是几秒前扫出来的，PID 可能已被系统复用。
 * @param {number} pid - 目标进程。
 * @param {number} port - 端口。
 * @returns {Promise<{pid:number, port:number, user:string|null, command:string}>} 校验结果。
 */
export async function verifyListener(pid, port) {
  if (pid === process.pid) throw new PortManagerApiError("refused", "这是 DSH 自己的进程，不能结束", 403);
  if (pid === process.ppid) throw new PortManagerApiError("refused", "这是 DSH 的父进程，不能结束", 403);
  if (pid <= 1) throw new PortManagerApiError("refused", "系统进程不能结束", 403);

  const listeners = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  const owners = new Set();
  let current = null;
  for (const line of listeners.stdout.split("\n")) {
    if (line.startsWith("p")) current = Number.parseInt(line.slice(1), 10);
    if (current !== null && Number.isInteger(current)) owners.add(current);
  }
  if (!owners.has(pid)) {
    throw new PortManagerApiError("not-listening", `PID ${pid} 现在没有监听 ${port} 端口（列表可能已过期，刷新试试）`, 409);
  }

  const ps = await runCommand("ps", ["-o", "uid=,user=,command=", "-p", String(pid)]);
  const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(ps.stdout.trim());
  if (match === null) throw new PortManagerApiError("not-found", `找不到进程 ${pid}`, 404);
  const uid = Number.parseInt(match[1], 10);
  const user = match[2];
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new PortManagerApiError("refused", `进程 ${pid} 属于 ${user}，当前用户无权结束它`, 403);
  }
  return { pid, port, user, command: match[3] };
}

/**
 * 进程是否还活着。
 * @param {number} pid - 进程号。
 * @returns {boolean} 是否存活。
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * 等待一小段时间。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 计时结束。
 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 结束一个进程：默认 SIGTERM，1.7s 内没退出则自动升级 SIGKILL。
 * @param {number} pid - 目标进程。
 * @param {"TERM"|"KILL"|"INT"} signal - 首发的信号。
 * @returns {Promise<{pid:number, signal:string, escalated:boolean, exited:boolean}>} 结果。
 */
export async function terminate(pid, signal) {
  const first = signal === "KILL" ? "SIGKILL" : signal === "INT" ? "SIGINT" : "SIGTERM";
  try {
    process.kill(pid, first);
  } catch (error) {
    if (error?.code === "ESRCH") return { pid, signal: first, escalated: false, exited: true };
    if (error?.code === "EPERM") throw new PortManagerApiError("refused", `没有权限结束进程 ${pid}`, 403);
    throw new PortManagerApiError("kill-failed", `结束进程 ${pid} 失败：${error?.message ?? error}`, 500);
  }
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await sleep(120);
    if (!isAlive(pid)) return { pid, signal: first, escalated: false, exited: true };
  }
  if (first !== "SIGTERM") return { pid, signal: first, escalated: false, exited: !isAlive(pid) };
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw new PortManagerApiError("kill-failed", `强制结束进程 ${pid} 失败：${error?.message ?? error}`, 500);
    }
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(120);
    if (!isAlive(pid)) return { pid, signal: "SIGKILL", escalated: true, exited: true };
  }
  return { pid, signal: first, escalated: true, exited: !isAlive(pid) };
}

/**
 * 用系统默认方式打开 URL。
 * @param {string} url - 已由服务端拼好的地址。
 * @returns {Promise<void>} 完成后返回。
 */
async function openExternal(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const result = await runCommand(command, args, 6_000);
  if (!result.ok) {
    throw new PortManagerApiError("open-failed", `无法打开 ${url}：${result.error?.message ?? "未知错误"}`, 500);
  }
}

/**
 * 对本地端口做一次 HTTP(S) 探测。
 * @param {number} port - 端口。
 * @param {string} path - 请求路径。
 * @param {boolean} tls - 是否走 https。
 * @returns {Promise<object>} 探测结果。
 */
function probeOnce(port, path, tls) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const send = tls ? httpsRequest : httpRequest;
    const req = send({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      timeout: 4_000,
      rejectUnauthorized: false,
      headers: { accept: "*/*", "user-agent": "dsh-port-manager" },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
        else res.destroy();
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: true,
          tls,
          status: res.statusCode ?? null,
          statusText: res.statusMessage ?? "",
          headers: {
            server: res.headers.server ?? null,
            poweredBy: res.headers["x-powered-by"] ?? null,
            contentType: res.headers["content-type"] ?? null,
            location: res.headers.location ?? null,
          },
          title: /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body)?.[1]?.trim() ?? null,
          bodyPreview: body.slice(0, 240),
          elapsedMs: Date.now() - startedAt,
        });
      });
      res.on("error", (error) => resolve({ ok: false, tls, message: error.message, elapsedMs: Date.now() - startedAt }));
    });
    req.on("timeout", () => req.destroy(new Error("探测超时（4s）")));
    req.on("error", (error) => resolve({ ok: false, tls, message: error.message, elapsedMs: Date.now() - startedAt }));
    req.end();
  });
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

/** 宿主半的插件名。 */
export const name = "dsh-port-manager";

/** 依赖的服务：只有 web 宿主提供 webServer（其它 profile 下本插件不激活）。 */
export const inject = ["webServer"];

/**
 * 插件入口：注册围栏 JSON 路由。
 * @param {object} ctx - cordis 上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const cache = new ScanCache();

  /**
   * 方法分发。
   * @param {string} method - API 方法名。
   * @param {object} payload - 请求体。
   * @param {import("node:http").IncomingMessage} req - 请求（用于推断自身端口）。
   * @returns {Promise<object>} 业务数据。
   */
  async function dispatch(method, payload, req) {
    const selfPort = selfPortOf(req);
    switch (method) {
      case "list": {
        const value = await cache.get({
          includeUdp: payload.includeUdp === true,
          selfPort,
          docker: payload.docker !== false,
          force: payload.force === true,
        });
        return { ...value, selfPort };
      }
      case "detail": {
        const pid = requireInt(payload, "pid");
        if (pid <= 1) throw new PortManagerApiError("bad-request", "pid 不合法");
        const ps = await runCommand("ps", ["-o", "pid=,ppid=,user=,etime=,%cpu=,%mem=,rss=,command=", "-p", String(pid)]);
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(ps.stdout.trim());
        if (match === null) throw new PortManagerApiError("not-found", `找不到进程 ${pid}`, 404);
        const parents = [];
        let cursor = Number.parseInt(match[2], 10);
        for (let depth = 0; depth < 4 && cursor > 1; depth += 1) {
          const parent = await runCommand("ps", ["-o", "pid=,comm=,ppid=", "-p", String(cursor)]);
          const parentMatch = /^\s*(\d+)\s+(.*?)\s+(\d+)\s*$/.exec(parent.stdout.trim());
          if (parentMatch === null) break;
          parents.push({ pid: Number.parseInt(parentMatch[1], 10), name: parentMatch[2].trim() });
          cursor = Number.parseInt(parentMatch[3], 10);
          if (!Number.isInteger(cursor)) break;
        }
        const scan = await cache.get({ includeUdp: true, selfPort, docker: false, force: true });
        const listeners = scan.ports.filter((entry) => entry.pid === pid);
        const cwdResult = await runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
        const cwd = cwdResult.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
        return {
          pid,
          ppid: Number.parseInt(match[2], 10),
          user: match[3],
          elapsed: match[4],
          cpu: Number.parseFloat(match[5]),
          mem: Number.parseFloat(match[6]),
          rssBytes: Number.parseInt(match[7], 10) * 1024,
          command: match[8],
          args: splitCommand(match[8]),
          cwd,
          parents,
          listeners: listeners.map((entry) => ({
            port: entry.port,
            protocol: entry.protocol,
            address: entry.address,
            url: entry.url,
            app: entry.app,
          })),
        };
      }
      case "kill": {
        const pid = requireInt(payload, "pid");
        const port = requireInt(payload, "port");
        const signal = payload.signal === "KILL" ? "KILL" : payload.signal === "INT" ? "INT" : "TERM";
        const verified = await verifyListener(pid, port);
        const result = await terminate(pid, signal);
        cache.entries.clear();
        return { ...result, ...verified };
      }
      case "open": {
        const port = requireInt(payload, "port");
        if (port <= 0 || port > 65_535) throw new PortManagerApiError("bad-request", "端口号不合法");
        const scheme = payload.scheme === "https" ? "https" : "http";
        const host = typeof payload.host === "string" && /^[A-Za-z0-9.:[\]_-]+$/.test(payload.host) ? payload.host : "localhost";
        const path = typeof payload.path === "string" && payload.path.startsWith("/") ? payload.path : "/";
        const url = `${scheme}://${host}:${port}${path}`;
        await openExternal(url);
        return { url };
      }
      case "reveal": {
        const path = typeof payload.path === "string" ? payload.path : "";
        if (path === "" || !existsSync(path)) throw new PortManagerApiError("not-found", "目录不存在或已被移动", 404);
        const isDirectory = statSync(path).isDirectory();
        const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        const target = isDirectory ? path : path.replace(/\/[^/]*$/, "");
        const args = process.platform === "darwin" && !isDirectory ? ["-R", path] : [target];
        const result = await runCommand(command, args, 6_000);
        if (!result.ok) throw new PortManagerApiError("reveal-failed", `无法打开 ${path}`, 500);
        return { path, isDirectory };
      }
      case "probe": {
        const port = requireInt(payload, "port");
        if (port <= 0 || port > 65_535) throw new PortManagerApiError("bad-request", "端口号不合法");
        const path = typeof payload.path === "string" && payload.path.startsWith("/") ? payload.path : "/";
        const first = await probeOnce(port, path, payload.scheme === "https");
        if (first.ok || payload.scheme !== undefined) return first;
        const second = await probeOnce(port, path, true);
        return second.ok ? second : { ...first, httpsAttempt: second };
      }
      default:
        throw new PortManagerApiError("not-found", `未知的接口方法 "${method}"`, 404);
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PATH,
    handler: async (req, res) => {
      const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];
      if (!isTrustedRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: { code: "method-error", message: "只接受 POST" } });
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
      const method = pathname.startsWith(`${API_PATH}/`) ? pathname.slice(API_PATH.length + 1) : undefined;
      if (method === undefined || method === "" || method.includes("/")) {
        writeError(res, new PortManagerApiError("not-found", "未知的接口方法", 404));
        return;
      }
      try {
        const payload = await readJsonBody(req);
        writeOk(res, await dispatch(method, payload, req));
      } catch (error) {
        writeError(res, error);
      }
    },
  }), "port-manager: api route");
}

export { scanPorts };
