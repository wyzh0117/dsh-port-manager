/**
 * 浏览器半的离线验收：用一个假的 `window.__ModuleLoader__` + 假 ctx 装载 bundle，
 * 断言它注册了原生右侧栏 page 类型与 keyed tab 主体，并用 react-dom/server 把
 * UI 真渲染成 HTML（无浏览器、无 jsdom），从而覆盖组件代码本身。
 *
 * React 从本机 dsh profile 的 node_modules 里按路径解析；找不到就跳过渲染断言
 * （注册断言仍然执行）。
 *
 * 运行：`node --test`。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

/** React 的候选安装位置（本机 profile / 兄弟插件优先，其次环境变量）。 */
const REACT_ROOTS = [
  process.env.DSH_REACT_ROOT,
  "/Users/youngi/.dsh/profiles/node_modules",
  "/Users/youngi/.dsh/profiles/web/node_modules",
  "/Users/youngi/Documents/MiniWork/dsh插件/dsh-notebook/node_modules",
].filter((entry) => typeof entry === "string" && entry !== "");

/**
 * 找一套可用的 react + react-dom/server。
 * @returns {{react:object, server:object, root:string}|null} 找到的模块。
 */
function findReact() {
  for (const root of REACT_ROOTS) {
    if (!existsSync(`${root}/react/package.json`)) continue;
    try {
      const req = createRequire(`${root}/index.js`);
      return { react: req("react"), server: req("react-dom/server"), root };
    } catch {
      // 换下一个候选。
    }
  }
  return null;
}

const reactPair = findReact();

/** 装载 bundle 并拿到它的 exports（factory 里的 require 只放行 react）。 */
async function loadBundle() {
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition; } } };
  await import(`../lib/client.js?test=${Date.now()}`);
  assert.notEqual(captured, null, "bundle 没有调用 window.__ModuleLoader__.load");
  assert.equal(captured.id, "dsh-port-manager", "模块 id 必须等于包名（启动图行 id）");
  const react = reactPair === null ? { createElement: () => ({}), Fragment: {} } : reactPair.react;
  const used = [];
  const exportsObj = captured.factory((specifier) => {
    used.push(specifier);
    if (specifier === "react") return react;
    throw new Error(`missed the module table: ${specifier}`);
  });
  return { definition: captured, exportsObj, used };
}

/** 造一个最小的客户端 ctx，记录注册动作。 */
function fakeContext() {
  const state = { types: [], registrations: [], disposers: 0 };
  const ctx = {
    effect(factory, label) {
      const disposer = factory();
      assert.equal(typeof disposer, "function", `ctx.effect("${label}") 必须返回 disposer`);
      state.disposers += 1;
      return () => disposer();
    },
    sidebarRightTabs: {
      register(definition) {
        state.types.push(definition);
        return () => {};
      },
    },
    slots: {
      inject(name, factory) {
        state.registrations.push({ hook: name, ...factory() });
        return () => {};
      },
      register(options, component) {
        return { options, component };
      },
    },
  };
  return { ctx, state };
}

/** 一条用于渲染断言的真实感端口记录。 */
const SAMPLE_ENTRY = {
  key: "tcp:3080:1276",
  port: 3080,
  protocol: "TCP",
  family: "IPv4",
  address: "127.0.0.1",
  bindings: [{ address: "127.0.0.1", family: "IPv4", scope: "local" }],
  scope: "local",
  state: "LISTEN",
  pid: 1276,
  ppid: 1,
  user: "youngi",
  uid: 501,
  name: "node",
  app: { title: "node · dsh", kind: "node", badge: "Node", detail: "/Users/youngi/.local/bin/dsh" },
  command: "node /Users/youngi/.local/bin/dsh web",
  args: ["node", "/Users/youngi/.local/bin/dsh", "web"],
  cwd: "/Users/youngi",
  elapsed: "12:03",
  elapsedSeconds: 723,
  cpu: 1.5,
  mem: 0.9,
  rssBytes: 524288000,
  container: null,
  url: "http://127.0.0.1:3080",
  localUrl: "http://localhost:3080",
  wellKnown: null,
  hostname: "mac",
  protected: false,
  protectedReason: null,
  killable: true,
};

test("bundle：只 require react，导出 apply/inject", async () => {
  const { exportsObj, used, definition } = await loadBundle();
  assert.equal(definition.id, "dsh-port-manager");
  // 真的门禁：假 require 只放行 react，其它说明符会抛错 —— 所以 used 必须恰好是 ["react"]。
  assert.deepEqual(used, ["react"]);
  assert.equal(typeof exportsObj.apply, "function");
  assert.deepEqual(exportsObj.inject, ["slots", "sidebarRightTabs"]);
});

test("注册：page 类型 + guide 入口 + tab 主体 + tab 标题", async () => {
  const { exportsObj } = await loadBundle();
  const { ctx, state } = fakeContext();
  exportsObj.apply(ctx);

  assert.equal(state.types.length, 1);
  const type = state.types[0];
  assert.equal(type.id, "dsh-port-manager");
  assert.equal(type.kind, "port-manager");
  assert.equal(type.priority, "extension");
  assert.equal(type.patterns, undefined, "page 类型不能声明 patterns");
  assert.equal(type.title("sidebar://port-manager"), "Port Manager");
  assert.equal(type.guide.length, 1);
  assert.equal(type.guide[0].order, 15, "guide 顺序：紧跟内置“文件”(10) 之后，且在 better-sidebar 的条目(30+) 之前");
  assert.equal(type.guide[0].title(), "Port Manager");
  assert.equal(typeof type.guide[0].description(), "string");
  assert.equal(typeof type.guide[0].icon, "function");

  const hooks = state.registrations.map((entry) => entry.hook).sort();
  assert.deepEqual(hooks, ["sidebar.right.pane.tab", "sidebar.right.pane.tab.title"]);
  for (const registration of state.registrations) {
    assert.equal(registration.options.name, registration.hook);
    assert.equal(registration.options.key, "dsh-port-manager", "key 必须等于类型的 id");
    assert.equal(typeof registration.component, "function");
  }
  assert.equal(state.disposers, 3, "类型 / 主体 / 标题三次注册都要挂在 ctx.effect 上");
});

test("渲染：tab 主体按 loading 态渲染，且不触碰 document/localStorage", async (t) => {
  if (reactPair === null) return t.skip("本机找不到 react，跳过渲染断言");
  const React = reactPair.react;
  const { exportsObj } = await loadBundle();
  const { ctx, state } = fakeContext();
  exportsObj.apply(ctx);
  const body = state.registrations.find((entry) => entry.hook === "sidebar.right.pane.tab").component;
  const html = reactPair.server.renderToStaticMarkup(React.createElement(body, {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: "pane-1" },
      tab: {
        id: "tab-1",
        title: "Port Manager",
        visible: true,
        signal: new AbortController().signal,
        actions: { openTab() {}, openResource() {}, close() {} },
      },
    }),
  }));
  assert.match(html, /Port Manager/);
  assert.match(html, /pgm-root/);
  assert.match(html, /正在扫描/);
  assert.match(html, /pgm-skel/);
  return undefined;
});

test("渲染：端口卡片显示端口、应用名、作用域与四种常用操作", async (t) => {
  if (reactPair === null) return t.skip("本机找不到 react，跳过渲染断言");
  const React = reactPair.react;
  const { exportsObj } = await loadBundle();
  const { PortCard } = exportsObj.__internals;
  const html = reactPair.server.renderToStaticMarkup(React.createElement(PortCard, {
    entry: SAMPLE_ENTRY,
    expanded: true,
    onToggle() {},
    onRefresh() {},
    toast() {},
  }));
  assert.match(html, /:3080/);
  assert.match(html, /node · dsh/);
  assert.match(html, /仅本机/);
  assert.match(html, /PID 1276/);
  assert.match(html, /12分/);
  assert.match(html, /500 MB/);
  // 四种常用操作 + 详情展开后的探测入口
  for (const label of ["打开", "复制", "收起", "定位", "结束"]) assert.ok(html.includes(label), `缺少操作按钮：${label}`);
  assert.match(html, /HTTP 探测/);
  assert.match(html, /pgm-mono/);
  return undefined;
});

test("渲染：受保护端口不给结束按钮，并显示保护原因", async (t) => {
  if (reactPair === null) return t.skip("本机找不到 react，跳过渲染断言");
  const React = reactPair.react;
  const { exportsObj } = await loadBundle();
  const { PortCard } = exportsObj.__internals;
  const entry = {
    ...SAMPLE_ENTRY,
    key: "tcp:7000:646",
    port: 7000,
    scope: "all",
    bindings: [{ address: "*", family: "IPv4", scope: "all" }],
    pid: 646,
    app: { title: "ControlCenter", kind: "other", badge: "Process", detail: "/System/Library/CoreServices/ControlCenter.app" },
    protected: true,
    protectedReason: "macOS 系统服务（AirPlay 接收器）",
    killable: false,
  };
  const html = reactPair.server.renderToStaticMarkup(React.createElement(PortCard, {
    entry,
    expanded: false,
    onToggle() {},
    onRefresh() {},
    toast() {},
  }));
  assert.match(html, /所有网卡/);
  assert.match(html, /macOS 系统服务（AirPlay 接收器）/);
  assert.match(html, /disabled/);
  return undefined;
});

test("纯函数：复制候选 / markdown 导出 / 时长与体积格式化", async () => {
  const { exportsObj } = await loadBundle();
  const internals = exportsObj.__internals;
  const choices = internals.copyChoices(SAMPLE_ENTRY);
  assert.ok(choices.some((choice) => choice.text === "localhost:3080"));
  assert.ok(choices.some((choice) => choice.text === "lsof -i :3080"));
  assert.ok(choices.some((choice) => choice.text === "kill 1276"));
  assert.ok(choices.some((choice) => choice.text === SAMPLE_ENTRY.cwd));

  const markdown = internals.exportMarkdown([SAMPLE_ENTRY]);
  assert.match(markdown, /\| 3080 \| TCP \| 127\.0\.0\.1:3080 \| node · dsh \| 1276 \| youngi \|/);

  assert.equal(internals.formatElapsed(45), "45秒");
  assert.equal(internals.formatElapsed(723), "12分");
  assert.equal(internals.formatElapsed(9355), "2小时35分");
  assert.equal(internals.formatElapsed(273611), "3天4小时");
  assert.equal(internals.formatBytes(524288000), "500 MB");
  assert.equal(internals.formatBytes(2 * 1024 * 1024 * 1024), "2.00 GB");
});
