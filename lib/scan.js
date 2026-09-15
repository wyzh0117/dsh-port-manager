/**
 * dsh-port-manager — 端口扫描与进程富化（纯逻辑 + 可注入的命令执行器）。
 *
 * 设计要点：
 *  - 扫描只用系统自带工具（macOS/Linux: lsof；Linux 回退: ss），不引入任何运行时依赖；
 *  - 解析函数全部是纯函数（输入命令文本、输出结构化记录），便于 `node --test` 直接覆盖；
 *  - 单次扫描最多 3 个外部命令（lsof + ps + 可选 lsof cwd / docker ps），批量取 PID 信息，
 *    避免 per-PID 调用；
 *  - 任何一条命令失败都不致命：降级返回已有信息，并在 `warnings` 里说明。
 *
 * @module dsh-port-manager/scan
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname as osHostname } from "node:os";

const run = promisify(execFile);

/** 外部命令默认超时（毫秒）。 */
const DEFAULT_TIMEOUT = 8_000;

/**
 * 执行一条外部命令，永不抛出：失败时把 stdout 也带回来（lsof 无匹配时退出码为 1）。
 * @param {string} file - 可执行文件名。
 * @param {string[]} args - 参数数组。
 * @param {number} [timeout] - 超时毫秒数。
 * @returns {Promise<{ok:boolean, stdout:string, code:number|null, error?:Error}>}
 */
export async function runCommand(file, args, timeout = DEFAULT_TIMEOUT) {
  try {
    const { stdout } = await run(file, args, {
      timeout,
      maxBuffer: 16 << 20,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    return { ok: true, stdout, code: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      code: typeof error?.code === "number" ? error.code : null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** 命令是否存在（用 which/where 探测一次并缓存）。 */
const availability = new Map();
/**
 * 判断命令是否可用。
 * @param {string} file - 可执行文件名。
 * @returns {Promise<boolean>} 是否可用。
 */
export async function hasCommand(file) {
  if (availability.has(file)) return availability.get(file);
  const probe = await runCommand(process.platform === "win32" ? "where" : "which", [file], 3_000);
  const ok = probe.ok && probe.stdout.trim() !== "";
  availability.set(file, ok);
  return ok;
}

/** Docker 是否很可能在跑：先看 socket，避免为一个没装的 Docker 白等 2.5s。 */
function dockerLikelyRunning() {
  for (const socket of ["/var/run/docker.sock", `${process.env.HOME ?? ""}/.docker/run/docker.sock`]) {
    try {
      if (socket !== "" && existsSync(socket)) return true;
    } catch {
      // 忽略：探测失败就当 Docker 没跑。
    }
  }
  return false;
}

// ── 纯解析函数 ──────────────────────────────────────────────────────────────

/**
 * 解析 `lsof -FpcuLPRnT` 的字段流。
 *
 * 字段流形如（每条记录一行，行首字母是字段名）：
 * ```
 * p646      ← PID
 * R1        ← PPID
 * cnode     ← 进程名（完整，不截断）
 * u501      ← UID
 * Lyoungi   ← 登录名
 * f19       ← 文件描述符（一个监听 socket）
 * PTCP      ← 协议
 * n127.0.0.1:3080  ← 地址:端口
 * TST=LISTEN
 * ```
 * @param {string} text - 命令输出。
 * @returns {Array<{pid:number, ppid:number|null, name:string, uid:number|null, user:string|null, fd:string|null, protocol:string, endpoint:string, state:string|null}>}
 */
export function parseLsofFields(text) {
  /** @type {Array<object>} */
  const rows = [];
  let proc = null;
  let file = null;
  const flush = () => {
    if (proc !== null && file !== null && file.endpoint !== null) rows.push({ ...proc, ...file });
    file = null;
  };
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;
    const tag = line[0];
    const value = line.slice(1);
    switch (tag) {
      case "p":
        flush();
        proc = {
          pid: Number.parseInt(value, 10),
          ppid: null,
          name: "",
          uid: null,
          user: null,
        };
        break;
      case "R":
        if (proc !== null) proc.ppid = Number.parseInt(value, 10);
        break;
      case "c":
        if (proc !== null) proc.name = value;
        break;
      case "u":
        if (proc !== null) proc.uid = Number.parseInt(value, 10);
        break;
      case "L":
        if (proc !== null) proc.user = value;
        break;
      case "f":
        flush();
        file = { fd: value, protocol: "TCP", endpoint: null, state: null };
        break;
      case "P":
        if (file !== null) file.protocol = value.toUpperCase();
        break;
      case "n":
        if (file !== null) file.endpoint = value;
        break;
      case "T": {
        if (file !== null && value.startsWith("ST=")) file.state = value.slice(3);
        break;
      }
      default:
        break;
    }
  }
  flush();
  return rows.filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

/**
 * 拆分 `lsof` 的端点字符串（`*:3080`、`127.0.0.1:3080`、`[::1]:3080`、`*:*`）。
 * @param {string} endpoint - `lsof -Fn` 给出的地址。
 * @returns {{address:string, port:number|null, family:"IPv4"|"IPv6"}} 解析结果。
 */
export function parseEndpoint(endpoint) {
  const text = String(endpoint);
  const family = text.includes("[") || (text.match(/:/g) ?? []).length > 1 ? "IPv6" : "IPv4";
  let address = text;
  let portText = "";
  if (family === "IPv6") {
    const close = text.lastIndexOf("]");
    if (close >= 0) {
      address = text.slice(0, close + 1);
      portText = text.slice(close + 2);
    } else {
      const cut = text.lastIndexOf(":");
      address = text.slice(0, cut);
      portText = text.slice(cut + 1);
    }
  } else {
    const cut = text.lastIndexOf(":");
    if (cut >= 0) {
      address = text.slice(0, cut);
      portText = text.slice(cut + 1);
    }
  }
  const port = /^\d+$/.test(portText) ? Number.parseInt(portText, 10) : null;
  return { address: address === "" ? "*" : address, port, family };
}

/**
 * 解析批量 `ps -o pid=,ppid=,user=,etime=,%cpu=,%mem=,rss=,command=` 的输出。
 *
 * `command` 放在最后一列（它可以含空格），其余列都是单 token。
 * @param {string} text - 命令输出。
 * @returns {Map<number, {pid:number, ppid:number|null, user:string, elapsed:string, elapsedSeconds:number, cpu:number, mem:number, rssBytes:number, command:string}>}
 */
export function parsePsTable(text) {
  const table = new Map();
  const pattern = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;
  for (const line of String(text).split("\n")) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const [, pid, ppid, user, elapsed, cpu, mem, rss, command] = match;
    table.set(Number.parseInt(pid, 10), {
      pid: Number.parseInt(pid, 10),
      ppid: Number.parseInt(ppid, 10),
      user,
      elapsed,
      elapsedSeconds: parseElapsed(elapsed),
      cpu: Number.parseFloat(cpu),
      mem: Number.parseFloat(mem),
      rssBytes: Number.parseInt(rss, 10) * 1024,
      command: command.trim(),
    });
  }
  return table;
}

/**
 * 把 `ps` 的 etime（`[[dd-]hh:]mm:ss`）换算成秒。
 * @param {string} text - etime 文本。
 * @returns {number} 秒数；无法解析时为 0。
 */
export function parseElapsed(text) {
  const value = String(text).trim();
  if (value === "") return 0;
  let rest = value;
  let days = 0;
  const dash = rest.indexOf("-");
  if (dash >= 0) {
    days = Number.parseInt(rest.slice(0, dash), 10) || 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts.slice(-3);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/**
 * 解析批量 `lsof -a -p … -d cwd -Fpn` 的输出，得到 PID → 工作目录。
 * @param {string} text - 命令输出。
 * @returns {Map<number, string>} PID 到 cwd 的映射。
 */
export function parseLsofCwd(text) {
  const map = new Map();
  let pid = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;
    if (line[0] === "p") {
      pid = Number.parseInt(line.slice(1), 10);
      continue;
    }
    if (line[0] === "n" && pid !== null && Number.isInteger(pid)) map.set(pid, line.slice(1));
  }
  return map;
}

/**
 * 解析 `docker ps --format "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}"`。
 * @param {string} text - 命令输出。
 * @returns {Map<number, {id:string, name:string, image:string}>} 宿主机端口 → 容器。
 */
export function parseDockerPs(text) {
  const map = new Map();
  for (const line of String(text).split("\n")) {
    if (line.trim() === "") continue;
    const [id, name, image, ports = ""] = line.split("\t");
    if (id === undefined || name === undefined) continue;
    for (const mapping of ports.split(",")) {
      // 形如 `0.0.0.0:5432->5432/tcp` 或 `[::]:8080->80/tcp`
      const match = /(?:^|[\s[])(?:[\d.]+|::|\*):(\d+)->/.exec(mapping);
      if (match === null) continue;
      map.set(Number.parseInt(match[1], 10), { id: id.slice(0, 12), name, image });
    }
  }
  return map;
}

/**
 * 解析 Linux `ss -ltnpH` / `ss -lunpH` 输出（没有 lsof 时的回退）。
 *
 * 形如：`LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=1276,fd=19))`
 * @param {string} text - 命令输出。
 * @param {"TCP"|"UDP"} protocol - 协议。
 * @returns {Array<object>} 与 `parseLsofFields` 同形的记录。
 */
export function parseSsOutput(text, protocol) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split(/\s+/);
    const local = parts.find((part) => /:\d+$|:\*$/.test(part) && part.includes(":")) ?? null;
    if (local === null) continue;
    const pidMatch = /pid=(\d+)/.exec(trimmed);
    const nameMatch = /\(\("([^"]+)"/.exec(trimmed);
    const uidMatch = /uid=(\d+)/.exec(trimmed);
    const userMatch = /user=([^\s,)]+)/.exec(trimmed);
    const stateMatch = /^(LISTEN|UNCONN|ESTAB)/.exec(parts[0] ?? "");
    const { address, port } = parseEndpoint(local);
    if (port === null) continue;
    rows.push({
      pid: pidMatch === null ? 0 : Number.parseInt(pidMatch[1], 10),
      ppid: null,
      name: nameMatch === null ? "" : nameMatch[1],
      uid: uidMatch === null ? null : Number.parseInt(uidMatch[1], 10),
      user: userMatch === null ? null : userMatch[1],
      fd: null,
      protocol,
      endpoint: local,
      state: stateMatch === null ? null : stateMatch[1],
      address,
      port,
    });
  }
  return rows;
}

// ── 语义推导 ────────────────────────────────────────────────────────────────

/** 开发服务器常见入口 → 展示名。 */
const NODE_TOOLS = [
  [/[/\\]node_modules[/\\]\.bin[/\\]([^/\\]+)/, (m) => m[1]],
  [/[/\\]\.bin[/\\]([^/\\]+)/, (m) => m[1]],
  [/[/\\]vite[/\\]/, () => "Vite"],
  [/[/\\]next[/\\]/, () => "Next.js"],
  [/[/\\]nuxt[/\\]/, () => "Nuxt"],
  [/[/\\]webpack/, () => "webpack"],
];

/**
 * 从命令行推断友好名字、进程类别与徽标。
 * @param {{name:string, command:string, args:string[], user:string|null, container?:{name:string, image:string}|undefined}} input - 原始信息。
 * @returns {{title:string, kind:string, badge:string, detail:string}} 展示用元信息。
 */
export function describeProcess({ name, command, args, container }) {
  if (container !== undefined) {
    return { title: container.name, kind: "docker", badge: "Docker", detail: container.image };
  }
  const exe = args.length > 0 ? args[0] : command.split(/\s+/)[0] ?? name;
  const base = exe.split("/").pop() ?? exe;
  const bundle = /\/Applications\/([^/]+)\.app\/|^([^/]+)\.app\//.exec(exe);
  if (bundle !== null) {
    const bundleName = (bundle[1] ?? bundle[2] ?? "").replace(/\.app$/, "");
    return { title: bundleName, kind: "app", badge: "App", detail: exe };
  }
  if (["node", "deno", "bun", "tsx", "ts-node"].includes(base)) {
    const script = firstScriptArg(args.slice(1));
    if (script !== null) {
      for (const [pattern, render] of NODE_TOOLS) {
        const match = pattern.exec(script);
        if (match !== null) {
          const label = render(match);
          return { title: `${base} · ${label}`, kind: "node", badge: "Node", detail: script };
        }
      }
      const label = script.split("/").pop() ?? script;
      return { title: `${base} · ${label.replace(/\.(?:[cm]?[jt]sx?|mjs|cjs)$/, "")}`, kind: "node", badge: "Node", detail: script };
    }
    return { title: base, kind: "node", badge: "Node", detail: command };
  }
  if (/^python[\d.]*$/.test(base)) {
    const script = firstScriptArg(args.slice(1));
    if (script !== null) return { title: `${base} · ${script.split("/").pop()}`, kind: "python", badge: "Python", detail: script };
    return { title: base, kind: "python", badge: "Python", detail: command };
  }
  if (/^ruby[\d.]*$/.test(base)) return { title: base, kind: "other", badge: "Ruby", detail: command };
  if (/^(java|go|php|dotnet|cargo|rustc)$/.test(base)) return { title: base, kind: "other", badge: base, detail: command };
  if (/^(docker-proxy|com\.docker|containerd|dockerd)/.test(base)) {
    return { title: base, kind: "docker", badge: "Docker", detail: command };
  }
  if (/^(mysqld|postgres|redis-server|mongod|nginx|httpd|apache2|mariadbd?)$/.test(base)) {
    return { title: base, kind: "service", badge: "Service", detail: command };
  }
  return { title: name === "" ? base : name, kind: "other", badge: "Process", detail: command };
}

/**
 * 取第一个非选项参数作为“脚本”。
 * @param {string[]} args - 命令行参数。
 * @returns {string|null} 脚本路径。
 */
function firstScriptArg(args) {
  for (const arg of args) {
    if (arg === "" || arg.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    return arg;
  }
  return null;
}

/**
 * 极简 shell 分词（支持引号与反斜杠转义），仅用于展示与推断。
 * @param {string} text - 命令行。
 * @returns {string[]} 参数数组。
 */
export function splitCommand(text) {
  const parts = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index];
      } else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      current += text[index];
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current !== "") {
        parts.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
  }
  if (started || current !== "") parts.push(current);
  return parts;
}

/**
 * 由监听地址判定可访问范围。
 * @param {string} address - `lsof` 给出的地址。
 * @returns {"local"|"lan"|"all"} loopback / 指定网卡 / 所有网卡。
 */
export function scopeOf(address) {
  if (address === "*" || address === "0.0.0.0" || address === "::" || address === "[::]") return "all";
  if (address === "localhost") return "local";
  if (address.startsWith("127.") || address === "[::1]" || address === "::1") return "local";
  return "lan";
}

/**
 * 端口号 → 常见服务名（用于“这是什么端口”的提示）。
 * @param {number} port - 端口号。
 * @returns {string|null} 常见用途；未知时为 null。
 */
export function wellKnownPort(port) {
  /** @type {Record<number,string>} */
  const table = {
    22: "SSH",
    25: "SMTP",
    53: "DNS",
    80: "HTTP",
    110: "POP3",
    143: "IMAP",
    443: "HTTPS",
    445: "SMB",
    587: "SMTP 提交",
    1080: "SOCKS",
    1433: "SQL Server",
    3000: "开发服务器（Node/React）",
    3001: "开发服务器",
    3306: "MySQL",
    4000: "开发服务器",
    4200: "Angular dev",
    5000: "macOS AirPlay / 开发服务器",
    5173: "Vite dev",
    5432: "PostgreSQL",
    6379: "Redis",
    7000: "macOS AirPlay 接收器",
    8000: "开发服务器（Python/HTTP）",
    8080: "HTTP 代理 / 开发服务器",
    8081: "开发服务器",
    8443: "HTTPS 备用",
    8888: "Jupyter / 开发服务器",
    9000: "PHP-FPM / 开发服务器",
    9229: "Node 调试器",
    27017: "MongoDB",
  };
  return table[port] ?? null;
}

// ── 扫描编排 ────────────────────────────────────────────────────────────────

/**
 * 扫描本机监听端口。
 * @param {{includeUdp?:boolean, network?:boolean, selfPort?:number|null, docker?:boolean}} [options] - 扫描选项。
 * @returns {Promise<object>} 结构化扫描结果。
 */
export async function scanPorts(options = {}) {
  const startedAt = Date.now();
  const includeUdp = options.includeUdp === true;
  const network = options.network !== false;
  const warnings = [];

  /** @type {Array<object>} */
  let rows = [];
  let source = "lsof";
  const hasLsof = await hasCommand("lsof");

  if (hasLsof) {
    const fields = "pcuLPRnT";
    const tcp = await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", `-F${fields}`]);
    rows.push(...parseLsofFields(tcp.stdout));
    if (includeUdp) {
      const udp = await runCommand("lsof", ["-nP", "-iUDP", `-F${fields}`]);
      rows.push(...parseLsofFields(udp.stdout));
    }
    if (!tcp.ok && tcp.stdout.trim() === "") {
      warnings.push(`lsof 未能返回结果：${tcp.error?.message ?? "未知错误"}`);
    }
  } else if (await hasCommand("ss")) {
    source = "ss";
    const tcp = await runCommand("ss", ["-ltnpH"]);
    rows.push(...parseSsOutput(tcp.stdout, "TCP"));
    if (includeUdp) {
      const udp = await runCommand("ss", ["-lunpH"]);
      rows.push(...parseSsOutput(udp.stdout, "UDP"));
    }
  } else {
    return {
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform: process.platform,
      source: "none",
      ports: [],
      stats: { ports: 0, apps: 0, tcp: 0, udp: 0, killable: 0, exposed: 0 },
      warnings: ["系统里找不到 lsof 或 ss，无法枚举监听端口。"],
    };
  }

  // 只保留有端口号的记录（lsof 偶尔给出无端口的 fd）。
  const listeners = [];
  for (const row of rows) {
    let { address, port, family } = row;
    if (address === undefined || !Number.isInteger(port)) {
      const parsed = parseEndpoint(row.endpoint ?? "");
      address = parsed.address;
      port = parsed.port;
      family = parsed.family;
    }
    if (!Number.isInteger(port) || port <= 0) continue;
    listeners.push({ ...row, address, port, family: family ?? (address.includes(":") ? "IPv6" : "IPv4") });
  }

  const pids = [...new Set(listeners.map((row) => row.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];

  // 三条命令互不依赖：并发跑，扫描延迟取最慢的一条。
  const wantDocker = options.docker !== false && dockerLikelyRunning() && await hasCommand("docker");
  const [psResult, cwdResult, dockerResult] = await Promise.all([
    pids.length > 0
      ? runCommand("ps", ["-o", "pid=,ppid=,user=,etime=,%cpu=,%mem=,rss=,command=", "-p", pids.join(",")])
      : Promise.resolve({ ok: true, stdout: "" }),
    hasLsof && pids.length > 0
      ? runCommand("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"])
      : Promise.resolve({ ok: true, stdout: "" }),
    wantDocker
      ? runCommand("docker", ["ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}"], 2_500)
      : Promise.resolve({ ok: false, stdout: "" }),
  ]);
  const psTable = parsePsTable(psResult.stdout);
  if (pids.length > 0 && psTable.size === 0) warnings.push("无法读取进程详情（ps 未返回数据）。");
  const cwdTable = parseLsofCwd(cwdResult.stdout);
  const containers = dockerResult.ok ? parseDockerPs(dockerResult.stdout) : new Map();

  // 同一个 (协议, 端口, 进程) 可能同时绑 IPv4 与 IPv6（例如 `*:5000` + `[::]:5000`），
  // 合并成一条记录、把多份绑定放进 `bindings`，列表才不会出现重复行。
  /** @type {Map<string, object>} */
  const grouped = new Map();
  for (const row of listeners) {
    const groupKey = `${row.protocol}:${row.port}:${row.pid}`;
    const existing = grouped.get(groupKey);
    const binding = { address: row.address, family: row.family, scope: scopeOf(row.address) };
    if (existing === undefined) grouped.set(groupKey, { row, bindings: [binding] });
    else if (!existing.bindings.some((entry) => entry.address === binding.address && entry.family === binding.family)) {
      existing.bindings.push(binding);
    }
  }

  const selfUid = typeof process.getuid === "function" ? process.getuid() : null;
  const hostname = safeHostname();
  const ports = [];
  for (const { row, bindings } of grouped.values()) {
    const info = psTable.get(row.pid);
    const command = info?.command ?? row.name;
    const args = splitCommand(command);
    const container = containers.get(row.port);
    const described = describeProcess({
      name: row.name,
      command,
      args,
      user: row.user ?? info?.user ?? null,
      container,
    });
    // 绑定里最“外”的那个决定这条记录的对外可达性。
    const rank = { local: 0, lan: 1, all: 2 };
    const primary = [...bindings].sort((left, right) => rank[right.scope] - rank[left.scope])[0];
    const scope = primary.scope;
    const protectedReason = protectionOf({
      port: row.port,
      pid: row.pid,
      name: row.name,
      selfPort: options.selfPort ?? null,
      user: row.user ?? info?.user ?? null,
      selfUid,
    }) ?? (info !== undefined && isSystemBinary(command) ? "macOS 系统自带程序" : null);
    const hostForUrl = primary.address === "*" || primary.address === "0.0.0.0" || primary.address === "::"
      ? "127.0.0.1"
      : primary.address.replace(/^\[|\]$/g, "");
    ports.push({
      key: `${row.protocol.toLowerCase()}:${row.port}:${row.pid}`,
      port: row.port,
      protocol: row.protocol,
      family: primary.family,
      address: primary.address,
      bindings,
      scope,
      state: row.state ?? (row.protocol === "TCP" ? "LISTEN" : null),
      pid: row.pid,
      ppid: info?.ppid ?? row.ppid ?? null,
      user: row.user ?? info?.user ?? null,
      uid: row.uid ?? null,
      name: row.name,
      app: described,
      command,
      args,
      cwd: cwdTable.get(row.pid) ?? null,
      elapsed: info?.elapsed ?? null,
      elapsedSeconds: info?.elapsedSeconds ?? null,
      cpu: Number.isFinite(info?.cpu) ? info.cpu : null,
      mem: Number.isFinite(info?.mem) ? info.mem : null,
      rssBytes: Number.isFinite(info?.rssBytes) ? info.rssBytes : null,
      container: container ?? null,
      url: `${isLikelyTls(row.port) ? "https" : "http"}://${hostForUrl}:${row.port}`,
      localUrl: `http://localhost:${row.port}`,
      wellKnown: wellKnownPort(row.port),
      hostname,
      protected: protectedReason !== null,
      protectedReason,
      killable: protectedReason === null && selfUid !== null && row.uid === selfUid && row.pid > 1,
    });
  }

  ports.sort((left, right) => left.port - right.port || left.address.localeCompare(right.address));
  const apps = new Set(ports.map((entry) => entry.pid)).size;
  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    platform: process.platform,
    source,
    network,
    ports,
    stats: {
      ports: ports.length,
      apps,
      tcp: ports.filter((entry) => entry.protocol === "TCP").length,
      udp: ports.filter((entry) => entry.protocol === "UDP").length,
      killable: ports.filter((entry) => entry.killable).length,
      exposed: ports.filter((entry) => entry.scope === "all" || entry.scope === "lan").length,
    },
    warnings,
  };
}

/**
 * 是否应当保护某个监听（不允许从本插件结束）。
 *
 * 保护策略：系统账号、macOS 的 ControlCenter（AirPlay 接收器，占了 5000/7000）、
 * 以及 DSH 自己监听的端口（结束了会连同当前界面一起消失）。
 * @param {{port:number, pid:number, name?:string, selfPort:number|null, user:string|null, selfUid:number|null}} input - 判定输入。
 * @returns {string|null} 保护原因；可结束时为 null。
 */
export function protectionOf({ port, pid, name, selfPort, user, selfUid }) {
  if (pid <= 1) return "系统启动进程，不能结束";
  if (Number.isInteger(selfPort) && port === selfPort) return "DSH 自己监听的端口（就是当前这个界面）";
  const SYSTEM_USERS = new Set([
    "root",
    "_windowserver",
    "_mdnsresponder",
    "_coreaudiod",
    "_appleevents",
    "_spotlight",
    "_locationd",
    "_distnoted",
    "_nsurlsessiond",
    "_securityd",
    "_softwareupdate",
  ]);
  if (user !== null && user !== undefined && SYSTEM_USERS.has(user)) return `属于系统账号 ${user}`;
  if (name === "ControlCenter" || name === "ControlCe") return "macOS 系统服务（AirPlay 接收器）";
  return null;
}

/**
 * 可执行文件是否位于系统目录（`/System`、`/usr/libexec` 等）——这类监听一律保护。
 * @param {string} command - 命令行。
 * @returns {boolean} 是否是系统自带程序。
 */
export function isSystemBinary(command) {
  const exe = String(command).trim().split(/\s+/)[0] ?? "";
  return /^\/(?:System|usr\/libexec|usr\/sbin|sbin|bin|usr\/bin)\//.test(exe);
}

/** 取主机名，失败时返回 null。 */
function safeHostname() {
  try {
    return osHostname();
  } catch {
    return null;
  }
}

/** 端口是否更可能说 TLS（仅用于默认打开链接的协议猜测）。 */
function isLikelyTls(port) {
  return port === 443 || port === 8443 || port === 9443;
}
