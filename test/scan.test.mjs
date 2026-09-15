/**
 * 宿主半解析逻辑的单测：全部用真实命令输出的样本喂纯函数，不依赖机器状态。
 *
 * 运行：`node --test`（或 `npm test`）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  describeProcess,
  displayNameOf,
  dockerLikelyRunning,
  parseDockerPs,
  parseElapsed,
  parseEndpoint,
  parseLsofCwd,
  parseLsofFields,
  parsePsTable,
  parseSsOutput,
  protectionOf,
  isSystemBinary,
  scopeOf,
  splitCommand,
  wellKnownPort,
} from "../lib/scan.js";

// ── lsof ────────────────────────────────────────────────────────────────────

/** 真实 `lsof -nP -iTCP -sTCP:LISTEN -FpcuLPRnT` 输出的节选。 */
const LSOF_TCP = [
  "p646",
  "R1",
  "cControlCenter",
  "u501",
  "Lyoungi",
  "f10",
  "PTCP",
  "n*:7000",
  "TST=LISTEN",
  "f12",
  "PTCP",
  "n*:5000",
  "TST=LISTEN",
  "p1276",
  "R1",
  "cnode",
  "u501",
  "Lyoungi",
  "f19",
  "PTCP",
  "n127.0.0.1:3080",
  "TST=LISTEN",
  "f20",
  "PTCP",
  "n[::1]:3080",
  "TST=LISTEN",
  "p898",
  "R1",
  "cOneDrive",
  "u501",
  "Lyoungi",
  "f35",
  "PTCP",
  "n[::1]:42050",
  "TST=LISTEN",
  "",
].join("\n");

test("parseLsofFields：一个 pid 的多个监听各自成行，字段全部解出", () => {
  const rows = parseLsofFields(LSOF_TCP);
  assert.equal(rows.length, 5);
  const first = rows[0];
  assert.deepEqual(
    { pid: first.pid, ppid: first.ppid, name: first.name, uid: first.uid, user: first.user, fd: first.fd, protocol: first.protocol, endpoint: first.endpoint, state: first.state },
    { pid: 646, ppid: 1, name: "ControlCenter", uid: 501, user: "youngi", fd: "10", protocol: "TCP", endpoint: "*:7000", state: "LISTEN" },
  );
  const ports = rows.map((row) => parseEndpoint(row.endpoint).port);
  assert.deepEqual(ports, [7000, 5000, 3080, 3080, 42050]);
  assert.equal(rows[2].protocol, "TCP");
  assert.deepEqual(parseEndpoint(rows[4].endpoint), { address: "[::1]", port: 42050, family: "IPv6" });
});

test("parseEndpoint：IPv4 / IPv6 / 通配 / 无端口", () => {
  assert.deepEqual(parseEndpoint("*:7000"), { address: "*", port: 7000, family: "IPv4" });
  assert.deepEqual(parseEndpoint("127.0.0.1:3080"), { address: "127.0.0.1", port: 3080, family: "IPv4" });
  assert.deepEqual(parseEndpoint("[::1]:42050"), { address: "[::1]", port: 42050, family: "IPv6" });
  assert.deepEqual(parseEndpoint("::1:42050"), { address: "::1", port: 42050, family: "IPv6" });
  assert.equal(parseEndpoint("*:*").port, null);
});

// ── ps ──────────────────────────────────────────────────────────────────────

test("parsePsTable：command 含空格也能整段取出", () => {
  const text = [
    "  646     1 youngi 02:35:55   6.4  0.2  16720 /System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter",
    " 1276     1 youngi    12:03   1.5  0.9 512000 node /Users/youngi/.local/bin/dsh web",
    " 3422     1 youngi  3-04:00:11  0.3  1.2 900000 /Applications/WeChat.app/Contents/MacOS/WeChat",
  ].join("\n");
  const table = parsePsTable(text);
  assert.equal(table.size, 3);
  const node = table.get(1276);
  assert.equal(node.command, "node /Users/youngi/.local/bin/dsh web");
  assert.equal(node.ppid, 1);
  assert.equal(node.cpu, 1.5);
  assert.equal(node.rssBytes, 512000 * 1024);
  assert.equal(table.get(3422).elapsedSeconds, 3 * 86400 + 4 * 3600 + 11);
});

test("parseElapsed：mm:ss / hh:mm:ss / dd-hh:mm:ss", () => {
  assert.equal(parseElapsed("00:42"), 42);
  assert.equal(parseElapsed("12:03"), 723);
  assert.equal(parseElapsed("02:35:55"), 9355);
  assert.equal(parseElapsed("3-04:00:11"), 273611);
  assert.equal(parseElapsed(""), 0);
});

test("parseLsofCwd：pid → cwd", () => {
  const map = parseLsofCwd("p1276\nfcwd\nn/Users/youngi\np1362\nfcwd\nn/tmp\n");
  assert.equal(map.get(1276), "/Users/youngi");
  assert.equal(map.get(1362), "/tmp");
});

// ── docker / ss ─────────────────────────────────────────────────────────────

test("parseDockerPs：容器端口映射反查", () => {
  const text = [
    "8f3a1b2c9d4e5f60718293a4b5c6d7e8f90123456789abcdef\tpg-local\ttimescale/timescaledb:latest-pg16\t0.0.0.0:5432->5432/tcp, :::5432->5432/tcp",
    "112233445566778899001122334455667788990011223344556677\tweb\tnginx:alpine\t0.0.0.0:8088->80/tcp",
  ].join("\n");
  const map = parseDockerPs(text);
  assert.equal(map.get(5432).name, "pg-local");
  assert.equal(map.get(5432).id, "8f3a1b2c9d4e");
  assert.equal(map.get(8088).image, "nginx:alpine");
  assert.equal(map.get(9999), undefined);
});

test("dockerLikelyRunning：按 socket 存在与否决定要不要调 docker", () => {
  // 用一个真实存在的临时文件当「socket」，避免依赖本机 Docker 装没装。
  const fake = `${tmpdir()}/pgm-docker-${process.pid}.sock`;
  writeFileSync(fake, "");
  try {
    assert.equal(dockerLikelyRunning([fake]), true);
    assert.equal(dockerLikelyRunning([`${fake}.nope`]), false);
    assert.equal(dockerLikelyRunning([""]), false);
    // 默认路径要么存在要么不存在，但绝不能抛（回归：existsSync 忘了 import 会 ReferenceError）。
    assert.equal(typeof dockerLikelyRunning(), "boolean");
  } finally {
    rmSync(fake, { force: true });
  }
});

test("parseSsOutput：Linux 回退解析", () => {
  const text = [
    "LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:((\"node\",pid=1276,fd=19))",
    "LISTEN 0 128 *:22 *:* users:((\"sshd\",pid=812,fd=3))",
  ].join("\n");
  const rows = parseSsOutput(text, "TCP");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].port, 3080);
  assert.equal(rows[0].pid, 1276);
  assert.equal(rows[0].name, "node");
  assert.equal(rows[1].address, "*");
});

// ── 语义 ────────────────────────────────────────────────────────────────────

test("splitCommand：引号与转义", () => {
  assert.deepEqual(splitCommand("node /a/b.js --port 3000"), ["node", "/a/b.js", "--port", "3000"]);
  assert.deepEqual(splitCommand(`"/Applications/My App.app/Contents/MacOS/My App" --flag`), ["/Applications/My App.app/Contents/MacOS/My App", "--flag"]);
  assert.deepEqual(splitCommand("a\\ b c"), ["a b", "c"]);
});

test("describeProcess：应用包 / node 脚本 / python / docker", () => {
  const app = describeProcess({
    name: "WeChat",
    command: "/Applications/WeChat.app/Contents/MacOS/WeChat",
    args: ["/Applications/WeChat.app/Contents/MacOS/WeChat"],
  });
  assert.equal(app.title, "WeChat");
  assert.equal(app.kind, "app");

  const vite = describeProcess({ name: "node", command: "node /w/app/node_modules/.bin/vite --port 5173", args: splitCommand("node /w/app/node_modules/.bin/vite --port 5173") });
  assert.equal(vite.title, "node · vite");
  assert.equal(vite.kind, "node");

  const dsh = describeProcess({ name: "node", command: "node /Users/me/.local/bin/dsh web", args: splitCommand("node /Users/me/.local/bin/dsh web") });
  assert.equal(dsh.title, "node · dsh");

  const python = describeProcess({ name: "Python", command: "python3 -m http.server 8000", args: splitCommand("python3 -m http.server 8000") });
  assert.equal(python.kind, "python");
  assert.equal(python.title, "python3 · http.server");

  // macOS 上应用路径带空格（`/Applications/Visual Studio Code.app/...`）也要认出来。
  const spaced = describeProcess({
    name: "Electron",
    command: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    args: splitCommand("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"),
  });
  assert.equal(spaced.title, "Visual Studio Code");
  assert.equal(spaced.kind, "app");

  // 框架版 Python 的 `Python.app/.../Python -m uvicorn` 应当显示成 python · uvicorn，
  // 而不是被当成一个叫 Python 的 GUI 应用。
  const frameworkPython = describeProcess({
    name: "Python",
    command: "/Library/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python -m uvicorn backend.main:app --port 8000",
    args: splitCommand("/Library/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python -m uvicorn backend.main:app --port 8000"),
  });
  assert.equal(frameworkPython.title, "python · uvicorn");
  assert.equal(frameworkPython.kind, "python");

  const docker = describeProcess({ name: "docker-proxy", command: "docker-proxy -container-port 5432", args: [], container: { name: "pg-local", image: "timescale/timescaledb" } });
  assert.equal(docker.title, "pg-local");
  assert.equal(docker.kind, "docker");
});

test("displayNameOf：把命令行缩成短名（父进程链展示用）", () => {
  assert.equal(displayNameOf("/Users/youngi/.h/.local/bin/python3.11 -m uvicorn app:api"), "python3.11");
  assert.equal(displayNameOf("/bin/zsh -l"), "zsh");
  assert.equal(displayNameOf(""), "(未知)");
});

test("scopeOf / wellKnownPort", () => {
  assert.equal(scopeOf("*"), "all");
  assert.equal(scopeOf("0.0.0.0"), "all");
  assert.equal(scopeOf("127.0.0.1"), "local");
  assert.equal(scopeOf("[::1]"), "local");
  assert.equal(scopeOf("192.168.0.100"), "lan");
  assert.equal(wellKnownPort(5173), "Vite dev");
  assert.equal(wellKnownPort(63000), null);
});

test("protectionOf / isSystemBinary：该护住的都护住", () => {
  assert.match(protectionOf({ port: 3080, pid: 1276, name: "node", selfPort: 3080, user: "youngi", selfUid: 501 }), /DSH 自己/);
  assert.match(protectionOf({ port: 7000, pid: 646, name: "ControlCenter", selfPort: 3080, user: "youngi", selfUid: 501 }), /AirPlay/);
  assert.match(protectionOf({ port: 22, pid: 812, name: "sshd", selfPort: null, user: "root", selfUid: 501 }), /系统账号/);
  assert.match(protectionOf({ port: 1, pid: 1, name: "launchd", selfPort: null, user: "root", selfUid: 501 }), /系统启动进程/);
  assert.equal(protectionOf({ port: 3000, pid: 4242, name: "node", selfPort: 3080, user: "youngi", selfUid: 501 }), null);
  assert.equal(isSystemBinary("/usr/libexec/rapportd -daemon"), true);
  assert.equal(isSystemBinary("/opt/homebrew/bin/node server.js"), false);
});
