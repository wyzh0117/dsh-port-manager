/**
 * dsh-port-manager — 浏览器半（dsh web 客户端 bundle）。
 *
 * 这是一个 **原生右侧栏应用**（page 类型 tab）：
 *   - 第一阶段 `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })`
 *     注册一个页面类型，并在侧栏 guide 页贡献一个 "Port Manager" 入口胶囊；
 *     用户打开右侧栏 → 点胶囊 → 本 tab 打开；
 *   - 第二阶段 `ctx.slots.register({ name: "sidebar.right.pane.tab", key: id }, Body)`
 *     注册 tab 主体，`useTabInfo()` 由插槽框架注入；
 *   - 另注册 `sidebar.right.pane.tab.title`，让 tab 胶囊带上自己的图标。
 *
 * 运行时是 `window.__ModuleLoader__`（模块 id === 包名 === 启动图行 id）。
 * `require()` 只能拿到模块表里的东西（react / react-dom / cordis / store / slots /
 * primitives / dockkit 这些种子词），拿别的会以 "missed the module table" 炸掉
 * 整个 bundle —— 所以本文件只 require("react")，图标一律内联 SVG。
 */
window.__ModuleLoader__.load({
  id: "dsh-port-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** tab 系统里的实现身份，也是 body / title 注册用的 key。 */
    const PORT_MANAGER_ID = "dsh-port-manager";
    /** 页面类型的 kind，`openTab("port-manager")` 用它。 */
    const PORT_MANAGER_KIND = "port-manager";
    /** 宿主半的 JSON 接口前缀。 */
    const API_BASE = "/port-manager/api";
    /** localStorage 里的偏好键。 */
    const PREFS_KEY = "dsh-port-manager:prefs";

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 用 dsh 自己的设计 token（都带兜底值），因此跟随明暗主题；与官方 side-files
    // 一样以带 data-plugin-css 的 <style> 注入，HMR 时由运行时按 tag id 回收。
    const CSS = `
.pgm-root{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#e8eaf0);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}
.pgm-head{flex:none;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,138,152,.28));display:flex;flex-direction:column;gap:8px}
.pgm-head-top{display:flex;align-items:center;gap:6px}
.pgm-title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;flex:none}
.pgm-count{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pgm-iconbtn{flex:none;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#a8b0bd);cursor:pointer}
.pgm-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,138,152,.16));color:var(--dsw-alias-label-primary,#e8eaf0)}
.pgm-iconbtn[disabled]{opacity:.45;cursor:default}
.pgm-iconbtn[data-spin="1"] svg{animation:pgm-spin .9s linear infinite}
@keyframes pgm-spin{to{transform:rotate(360deg)}}
.pgm-search{width:100%;box-sizing:border-box;padding:5px 9px 5px 26px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#e8eaf0);background:var(--dsw-alias-bg-layer-2,rgba(128,138,152,.1));border:.5px solid var(--dsw-alias-border-l3,rgba(128,138,152,.28));border-radius:7px;outline:none}
.pgm-search:focus{border-color:var(--dsw-alias-brand-primary,#4c8dff)}
.pgm-search::placeholder{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.pgm-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.pgm-chip{font-size:11px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,138,152,.28));background:transparent;color:var(--dsw-alias-label-secondary,#a8b0bd);cursor:pointer;white-space:nowrap}
.pgm-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,138,152,.16))}
.pgm-chip[data-on="1"]{background:var(--dsw-alias-button-ghost-active-fill,rgba(76,141,255,.16));border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-label-primary,#e8eaf0)}
.pgm-spacer{flex:1}
.pgm-select{font:inherit;font-size:11px;padding:2px 4px;border-radius:6px;color:var(--dsw-alias-label-secondary,#a8b0bd);background:var(--dsw-alias-bg-layer-2,rgba(128,138,152,.1));border:.5px solid var(--dsw-alias-border-l3,rgba(128,138,152,.28))}
.pgm-body{flex:1;min-height:0;overflow:auto;padding:8px 8px 16px;scrollbar-gutter:stable}
.pgm-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.pgm-card{border:.5px solid var(--dsw-alias-border-l3,rgba(128,138,152,.28));border-radius:10px;padding:8px 9px;background:var(--dsw-alias-bg-layer-1,transparent);display:flex;flex-direction:column;gap:5px}
.pgm-card:hover{border-color:var(--dsw-alias-border-l2,rgba(128,138,152,.4))}
.pgm-card[data-protected="1"]{background:var(--dsw-alias-bg-layer-2,rgba(128,138,152,.06))}
.pgm-row1{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.pgm-port{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;font-weight:600;letter-spacing:.2px}
.pgm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pgm-meta{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}
.pgm-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:.5px solid currentColor;white-space:nowrap}
.pgm-scope-local{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.pgm-scope-lan{color:var(--dsw-alias-state-business-primary,#4c8dff)}
.pgm-scope-all{color:var(--dsw-alias-state-warn-primary,#e6a23c)}
.pgm-app{display:flex;align-items:center;gap:6px;min-width:0}
.pgm-dot{flex:none;width:7px;height:7px;border-radius:50%}
.pgm-appname{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pgm-line2{color:var(--dsw-alias-label-secondary,#a8b0bd);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pgm-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:1px}
.pgm-btn{font:inherit;font-size:11.5px;display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,138,152,.28));background:var(--dsw-alias-button-tool-bar-fill,transparent);color:var(--dsw-alias-label-secondary,#a8b0bd);cursor:pointer}
.pgm-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,138,152,.16));color:var(--dsw-alias-label-primary,#e8eaf0)}
.pgm-btn[disabled]{opacity:.4;cursor:default}
.pgm-btn[data-tone="primary"]{color:var(--dsw-alias-brand-primary,#4c8dff);border-color:var(--dsw-alias-brand-primary,#4c8dff)}
.pgm-btn[data-tone="danger"]{color:var(--dsw-alias-state-error-primary,#f2555a);border-color:var(--dsw-alias-state-error-primary,#f2555a)}
.pgm-btn[data-tone="danger"]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(242,85,90,.16))}
.pgm-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(242,85,90,.1));border:.5px solid var(--dsw-alias-state-error-primary,#f2555a);font-size:11.5px}
.pgm-detail{display:flex;flex-direction:column;gap:6px;border-top:.5px dashed var(--dsw-alias-border-l3,rgba(128,138,152,.28));padding-top:6px;font-size:11.5px}
.pgm-kv{display:flex;gap:6px;min-width:0}
.pgm-k{flex:none;width:60px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.pgm-v{min-width:0;flex:1;word-break:break-all;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#a8b0bd)}
.pgm-vlink{cursor:pointer;text-decoration:underline dotted}
.pgm-bindings{display:flex;flex-wrap:wrap;gap:4px}
.pgm-probe{border:.5px solid var(--dsw-alias-border-l3,rgba(128,138,152,.28));border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:4px}
.pgm-toast{position:sticky;bottom:0;align-self:center;margin-top:6px;padding:4px 10px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#1b1e24);color:var(--dsw-alias-label-primary,#fff);font-size:11.5px;box-shadow:0 4px 14px rgba(0,0,0,.3);width:fit-content}
.pgm-state{padding:18px 12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;color:var(--dsw-alias-label-secondary,#a8b0bd)}
.pgm-state h4{margin:0;font-size:13px;color:var(--dsw-alias-label-primary,#e8eaf0)}
.pgm-err{color:var(--dsw-alias-state-error-primary,#f2555a);font-size:11.5px;word-break:break-word}
.pgm-warn{color:var(--dsw-alias-state-warn-primary,#e6a23c);font-size:11px}
.pgm-skel{height:52px;border-radius:10px;background:var(--dsw-alias-bg-skeleton,rgba(128,138,152,.12));animation:pgm-pulse 1.2s ease-in-out infinite}
@keyframes pgm-pulse{50%{opacity:.55}}
.pgm-menu{position:relative;display:inline-flex}
.pgm-menu-list{position:absolute;z-index:30;top:calc(100% + 4px);left:0;min-width:196px;padding:4px;border-radius:9px;background:var(--dsw-alias-bg-overlay,#1b1e24);border:.5px solid var(--dsw-alias-border-l2,rgba(128,138,152,.4));box-shadow:0 8px 22px rgba(0,0,0,.35);display:flex;flex-direction:column}
.pgm-menu-item{font:inherit;font-size:11.5px;text-align:left;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#a8b0bd);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pgm-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,138,152,.16));color:var(--dsw-alias-label-primary,#e8eaf0)}
`;

    const CSS_TAG_ID = "dsh-port-manager/PortManager.css";
    if (typeof document !== "undefined"
      && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-port-manager";
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── 图标（内联 SVG，避免 require 非种子包）───────────────────────────────
    /**
     * 16px 线性图标外框。
     * @param {object} props - `{children, size, className}`。
     * @returns {object} React 元素。
     */
    function Icon({ children, size = 16, className }) {
      return h("svg", {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        className,
        "aria-hidden": "true",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.3,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        style: { display: "block", flexShrink: 0 },
      }, children);
    }
    const IconPlug = (props) => h(Icon, props,
      h("path", { d: "M5.5 2v3.2M10.5 2v3.2" }),
      h("path", { d: "M3.6 5.2h8.8v2.1a4.4 4.4 0 0 1-4.4 4.4 4.4 4.4 0 0 1-4.4-4.4z" }),
      h("path", { d: "M8 11.7V14" }));
    const IconRefresh = (props) => h(Icon, props,
      h("path", { d: "M13.4 8a5.4 5.4 0 1 1-1.6-3.8" }),
      h("path", { d: "M13.6 2.2v3.1h-3.1" }));
    const IconOpen = (props) => h(Icon, props,
      h("path", { d: "M9.2 2.6h4.2v4.2" }),
      h("path", { d: "M13.4 2.6 7.6 8.4" }),
      h("path", { d: "M12 9.6v3.2a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V5.8a1.2 1.2 0 0 1 1.2-1.2h3.2" }));
    const IconCopy = (props) => h(Icon, props,
      h("rect", { x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 1.6 }),
      h("path", { d: "M10.6 5.2V3.8a1.2 1.2 0 0 0-1.2-1.2H3.8a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.4" }));
    const IconInfo = (props) => h(Icon, props,
      h("circle", { cx: 8, cy: 8, r: 6 }),
      h("path", { d: "M8 7.2v4M8 4.9v.7" }));
    const IconFolder = (props) => h(Icon, props,
      h("path", { d: "M2.4 12.2V4.6a1 1 0 0 1 1-1h2.5l1.3 1.6h4.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z" }));
    const IconPower = (props) => h(Icon, props,
      h("path", { d: "M8 2.6v5" }),
      h("path", { d: "M11.6 4.4a5.2 5.2 0 1 1-7.2 0" }));
    const IconLock = (props) => h(Icon, props,
      h("rect", { x: 3.4, y: 7, width: 9.2, height: 6.4, rx: 1.5 }),
      h("path", { d: "M5.7 7V5.4a2.3 2.3 0 0 1 4.6 0V7" }));
    const IconSearch = (props) => h(Icon, props,
      h("circle", { cx: 7.2, cy: 7.2, r: 4.4 }),
      h("path", { d: "m10.6 10.6 2.8 2.8" }));
    const IconBolt = (props) => h(Icon, props,
      h("path", { d: "M8.8 1.8 3.6 9.2h3.4l-.8 5 5.2-7.4H8z" }));

    // ── 宿主接口 ────────────────────────────────────────────────────────────
    /**
     * 调用宿主半的 JSON 接口。
     * @param {string} method - 接口方法。
     * @param {object} [payload] - 请求体。
     * @returns {Promise<object>} 业务数据。
     */
    async function api(method, payload) {
      let response;
      try {
        response = await fetch(`${API_BASE}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload ?? {}),
        });
      } catch (error) {
        throw new Error(`无法连接宿主：${error instanceof Error ? error.message : String(error)}`);
      }
      const parsed = await response.json().catch(() => null);
      if (response.ok !== true || parsed === null || parsed.ok !== true) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
      }
      return parsed.value;
    }

    // ── 展示助手 ────────────────────────────────────────────────────────────
    const KIND_COLOR = {
      node: "#7bc96f",
      python: "#5aa9e6",
      docker: "#2496ed",
      app: "#c792ea",
      service: "#e6a23c",
      other: "#8a8f98",
    };
    const SCOPE_LABEL = { local: "仅本机", lan: "局域网", all: "所有网卡" };
    const KIND_LABEL = {
      node: "Node",
      python: "Python",
      docker: "Docker",
      app: "应用",
      service: "服务",
      other: "进程",
    };

    /**
     * 秒 → 中文时长。
     * @param {number|null} seconds - 秒数。
     * @returns {string} 展示文本。
     */
    function formatElapsed(seconds) {
      if (typeof seconds !== "number" || seconds <= 0) return "";
      const day = Math.floor(seconds / 86400);
      const hour = Math.floor((seconds % 86400) / 3600);
      const minute = Math.floor((seconds % 3600) / 60);
      if (day > 0) return `${day}天${hour > 0 ? `${hour}小时` : ""}`;
      if (hour > 0) return `${hour}小时${minute > 0 ? `${minute}分` : ""}`;
      if (minute > 0) return `${minute}分`;
      return `${seconds}秒`;
    }

    /**
     * 字节 → 人类可读。
     * @param {number|null} bytes - 字节数。
     * @returns {string} 展示文本。
     */
    function formatBytes(bytes) {
      if (typeof bytes !== "number" || bytes <= 0) return "";
      const mb = bytes / (1024 * 1024);
      if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
      if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
      return `${(mb / 1024).toFixed(2)} GB`;
    }

    /**
     * ISO 时间 → “x 秒前”。
     * @param {string|null} iso - ISO 时间串。
     * @returns {string} 展示文本。
     */
    function formatAgo(iso) {
      if (typeof iso !== "string") return "";
      const delta = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      if (delta < 2) return "刚刚";
      if (delta < 60) return `${delta} 秒前`;
      if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
      return `${Math.floor(delta / 3600)} 小时前`;
    }

    /**
     * 复制文本到剪贴板（带 execCommand 兜底）。
     * @param {string} text - 要复制的内容。
     * @returns {Promise<boolean>} 是否成功。
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // 落到 execCommand 兜底。
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    /**
     * 读取本地偏好。
     * @returns {object} 偏好对象。
     */
    function loadPrefs() {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        return raw === null ? {} : JSON.parse(raw);
      } catch {
        return {};
      }
    }

    /**
     * 写入本地偏好。
     * @param {object} prefs - 偏好对象。
     * @returns {void}
     */
    function savePrefs(prefs) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // 隐私模式下不可写：忽略。
      }
    }

    /**
     * 一条端口记录的可复制候选。
     * @param {object} entry - 端口记录。
     * @returns {Array<{label:string, text:string}>} 候选列表。
     */
    function copyChoices(entry) {
      const items = [
        { label: `localhost:${entry.port}`, text: `localhost:${entry.port}` },
        { label: `http://localhost:${entry.port}`, text: `http://localhost:${entry.port}` },
        { label: `:${entry.port}`, text: `:${entry.port}` },
        { label: `lsof -i :${entry.port}`, text: `lsof -i :${entry.port}` },
      ];
      if (entry.pid > 1) items.push({ label: `kill ${entry.pid}`, text: `kill ${entry.pid}` });
      if (typeof entry.cwd === "string" && entry.cwd !== "") items.push({ label: "复制工作目录", text: entry.cwd });
      if (typeof entry.command === "string" && entry.command !== "" && entry.command !== entry.name) {
        items.push({ label: "复制启动命令", text: entry.command });
      }
      return items;
    }

    /**
     * 把当前可见端口导出成 markdown（方便贴进对话里让模型排查）。
     * @param {Array<object>} entries - 端口记录。
     * @returns {string} markdown 文本。
     */
    function exportMarkdown(entries) {
      const lines = [
        "| 端口 | 协议 | 绑定 | 应用 | PID | 用户 |",
        "| --- | --- | --- | --- | --- | --- |",
      ];
      for (const entry of entries) {
        lines.push(`| ${entry.port} | ${entry.protocol} | ${entry.bindings.map((binding) => `${binding.address}:${entry.port}`).join(" ")} | ${entry.app.title} | ${entry.pid} | ${entry.user ?? "-"} |`);
      }
      return lines.join("\n");
    }

    // ── 子组件 ──────────────────────────────────────────────────────────────

    /**
     * 行内复制菜单。
     * @param {object} props - `{entry, onCopied}`。
     * @returns {object} React 元素。
     */
    function CopyMenu({ entry, onCopied }) {
      const [open, setOpen] = useState(false);
      const boxRef = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (boxRef.current !== null && !boxRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, [open]);
      return h("div", { className: "pgm-menu", ref: boxRef },
        h("button", {
          type: "button",
          className: "pgm-btn",
          "aria-expanded": open,
          onClick: () => setOpen((value) => !value),
          title: "复制端口 / 地址 / 命令",
        }, h(IconCopy, { size: 13 }), "复制"),
        open && h("div", { className: "pgm-menu-list", role: "menu" },
          copyChoices(entry).map((choice) => h("button", {
            key: choice.label,
            type: "button",
            role: "menuitem",
            className: "pgm-menu-item",
            onClick: async () => {
              setOpen(false);
              onCopied(await copyText(choice.text) ? `已复制 ${choice.label}` : "复制失败，请手动选择");
            },
          }, choice.label))));
    }

    /**
     * 端口详情：进程信息 + 绑定 + HTTP 探测。
     * @param {object} props - `{entry, toast}`。
     * @returns {object} React 元素。
     */
    function PortDetail({ entry, toast }) {
      const [detail, setDetail] = useState(null);
      const [detailError, setDetailError] = useState(null);
      const [probe, setProbe] = useState(null);
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        let alive = true;
        api("detail", { pid: entry.pid })
          .then((value) => { if (alive) setDetail(value); })
          .catch((error) => { if (alive) setDetailError(error.message); });
        return () => { alive = false; };
      }, [entry.pid]);

      const runProbe = async () => {
        setBusy(true);
        setProbe(null);
        try {
          setProbe(await api("probe", { port: entry.port }));
        } catch (error) {
          setProbe({ ok: false, message: error.message });
        } finally {
          setBusy(false);
        }
      };

      /**
       * 一行 key/value。
       * @param {string} key - 字段名。
       * @param {object} value - 值（React 节点）。
       * @param {object} [options] - `{link, onClick, title}`。
       * @returns {object} React 元素。
       */
      const row = (key, value, options = {}) => h("div", { className: "pgm-kv", key },
        h("div", { className: "pgm-k" }, key),
        h("div", {
          className: `pgm-v${options.link === true ? " pgm-vlink" : ""}`,
          title: options.title,
          onClick: options.onClick,
        }, value));

      return h("div", { className: "pgm-detail" },
        detailError !== null && h("div", { className: "pgm-err" }, `读取进程详情失败：${detailError}`),
        detail !== null && h(React.Fragment, null,
          row("命令行", detail.command, {
            title: "点击复制",
            onClick: async () => toast(await copyText(detail.command) ? "已复制启动命令" : "复制失败"),
          }),
          detail.cwd !== null && detail.cwd !== undefined && row("工作目录", detail.cwd, {
            link: true,
            title: "点击在文件管理器里打开",
            onClick: async () => {
              try {
                await api("reveal", { path: detail.cwd });
              } catch (error) {
                toast(error.message);
              }
            },
          }),
          row("进程", `PID ${detail.pid} · 父 PID ${detail.ppid} · ${detail.user} · 运行 ${detail.elapsed}`),
          row("资源", `CPU ${detail.cpu}% · 内存 ${detail.mem}% · ${formatBytes(detail.rssBytes) || "-"}`),
          detail.parents.length > 0 && row("父进程链", detail.parents.map((parent) => `${parent.name}(${parent.pid})`).join(" ← ")),
          row("绑定", h("div", { className: "pgm-bindings" }, entry.bindings.map((binding) => h("span", {
            key: `${binding.family}-${binding.address}`,
            className: `pgm-badge pgm-scope-${binding.scope}`,
          }, `${binding.address}:${entry.port} · ${binding.family} · ${SCOPE_LABEL[binding.scope]}`)))),
          entry.container !== null && entry.container !== undefined
            && row("容器", `${entry.container.name} · ${entry.container.image}`)),
        h("div", { className: "pgm-probe" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("button", {
              type: "button",
              className: "pgm-btn",
              disabled: busy,
              onClick: runProbe,
              title: "发一个 HTTP GET，判断它是不是网页服务",
            }, h(IconBolt, { size: 13 }), busy ? "探测中…" : "HTTP 探测"),
            h("span", { className: "pgm-meta" }, "只请求本机")),
          probe !== null && (probe.ok === true
            ? h("div", { className: "pgm-v" },
              `${probe.tls ? "https" : "http"} · ${probe.status} ${probe.statusText} · ${probe.elapsedMs}ms`,
              probe.headers.server !== null ? `\nServer: ${probe.headers.server}` : "",
              probe.headers.poweredBy !== null ? `\nX-Powered-By: ${probe.headers.poweredBy}` : "",
              probe.headers.contentType !== null ? `\nContent-Type: ${probe.headers.contentType}` : "",
              probe.title !== null && probe.title !== "" ? `\n标题: ${probe.title}` : "")
            : h("div", { className: "pgm-err" }, `没有响应：${probe.message}`))));
    }

    /**
     * 结束进程的二次确认条。
     * @param {object} props - `{entry, onCancel, onDone, toast}`。
     * @returns {object} React 元素。
     */
    function KillConfirm({ entry, onCancel, onDone, toast }) {
      const [busy, setBusy] = useState(false);
      const run = async (signal) => {
        setBusy(true);
        try {
          const result = await api("kill", { pid: entry.pid, port: entry.port, signal });
          const escalated = result.escalated === true ? "（SIGTERM 未生效，已强制结束）" : "";
          toast(`已结束 ${entry.app.title}（PID ${entry.pid}，${result.signal}）${escalated}`);
          onDone();
        } catch (error) {
          toast(error.message);
          setBusy(false);
        }
      };
      return h("div", { className: "pgm-confirm" },
        h("span", null, `确认结束 ${entry.app.title}（PID ${entry.pid}）？`),
        h("button", { type: "button", className: "pgm-btn", "data-tone": "danger", disabled: busy, onClick: () => run("TERM") }, "结束进程"),
        h("button", { type: "button", className: "pgm-btn", "data-tone": "danger", disabled: busy, onClick: () => run("KILL"), title: "直接 SIGKILL，进程没有清理机会" }, "强制 -9"),
        h("button", { type: "button", className: "pgm-btn", disabled: busy, onClick: onCancel }, "取消"));
    }

    /**
     * 单条端口卡片：基本信息 + 常用操作。
     * @param {object} props - `{entry, expanded, onToggle, onRefresh, toast}`。
     * @returns {object} React 元素。
     */
    function PortCard({ entry, expanded, onToggle, onRefresh, toast }) {
      const [confirming, setConfirming] = useState(false);
      const reveal = async () => {
        if (typeof entry.cwd !== "string" || entry.cwd === "") {
          toast("这个进程的工作目录读不到");
          return;
        }
        try {
          await api("reveal", { path: entry.cwd });
        } catch (error) {
          toast(error.message);
        }
      };
      const open = async () => {
        try {
          const value = await api("open", { port: entry.port, scheme: entry.url.startsWith("https") ? "https" : "http" });
          toast(`已用默认浏览器打开 ${value.url}`);
        } catch (error) {
          toast(error.message);
        }
      };
      const meta = [
        `PID ${entry.pid}`,
        entry.user,
        formatElapsed(entry.elapsedSeconds),
        entry.cpu !== null ? `CPU ${entry.cpu}%` : null,
        entry.rssBytes !== null ? formatBytes(entry.rssBytes) : null,
      ].filter((part) => part !== null && part !== undefined && part !== "").join(" · ");
      const subtitle = entry.cwd !== null && entry.cwd !== undefined && entry.cwd !== ""
        ? entry.cwd
        : entry.command;

      return h("li", { className: "pgm-card", "data-protected": entry.protected ? "1" : "0", "data-port": entry.port },
        h("div", { className: "pgm-row1" },
          h("span", { className: "pgm-port" }, `:${entry.port}`),
          h("span", {
            className: `pgm-badge pgm-scope-${entry.scope}`,
            title: entry.scope === "local" ? "只监听回环地址，只有本机能访问" : "绑在非回环地址上：同一网络的其他设备也能访问",
          }, SCOPE_LABEL[entry.scope]),
          h("span", { className: "pgm-meta" }, entry.protocol),
          entry.wellKnown !== null && h("span", { className: "pgm-meta", title: "常见用途" }, entry.wellKnown),
          h("span", { className: "pgm-spacer" }),
          entry.protected && h("span", { className: "pgm-meta", title: entry.protectedReason ?? "这个监听受保护" },
            h(IconLock, { size: 13 }))),
        h("div", { className: "pgm-app" },
          h("span", { className: "pgm-dot", style: { background: KIND_COLOR[entry.app.kind] ?? KIND_COLOR.other } }),
          h("span", { className: "pgm-appname", title: entry.app.detail }, entry.app.title),
          h("span", { className: "pgm-badge", style: { color: KIND_COLOR[entry.app.kind] ?? KIND_COLOR.other } },
            KIND_LABEL[entry.app.kind] ?? entry.app.kind)),
        meta !== "" && h("div", { className: "pgm-line2" }, meta),
        subtitle !== null && subtitle !== undefined && subtitle !== "" && h("div", { className: "pgm-line2 pgm-mono", title: subtitle }, subtitle),
        confirming
          ? h(KillConfirm, { entry, toast, onCancel: () => setConfirming(false), onDone: () => { setConfirming(false); onRefresh(); } })
          : h("div", { className: "pgm-actions" },
            h("button", {
              type: "button",
              className: "pgm-btn",
              "data-tone": "primary",
              disabled: entry.protocol !== "TCP",
              onClick: open,
              title: `用系统默认浏览器打开 http://localhost:${entry.port}`,
            }, h(IconOpen, { size: 13 }), "打开"),
            h(CopyMenu, { entry, onCopied: toast }),
            h("button", {
              type: "button",
              className: "pgm-btn",
              "aria-expanded": expanded,
              onClick: () => onToggle(expanded ? null : entry.key),
            }, h(IconInfo, { size: 13 }), expanded ? "收起" : "详情"),
            h("button", {
              type: "button",
              className: "pgm-btn",
              disabled: entry.cwd === null || entry.cwd === undefined || entry.cwd === "",
              onClick: reveal,
              title: entry.cwd ?? "读不到工作目录",
            }, h(IconFolder, { size: 13 }), "定位"),
            h("button", {
              type: "button",
              className: "pgm-btn",
              "data-tone": "danger",
              disabled: !entry.killable || entry.protocol !== "TCP",
              onClick: () => setConfirming(true),
              title: entry.protected ? (entry.protectedReason ?? "这个监听受保护") : `结束占用 ${entry.port} 端口的进程：先 SIGTERM，1.7 秒不退出再 SIGKILL`,
            }, h(IconPower, { size: 13 }), "结束")),
        expanded && h(PortDetail, { entry, toast }));
    }

    // ── tab 主体 ────────────────────────────────────────────────────────────

    /**
     * Port Manager 的 tab 主体。`useTabInfo` 由 sidebar-right 的插槽框架注入。
     * @param {object} props - 框架注入的属性。
     * @returns {object} React 元素。
     */
    function PortManagerBody({ useTabInfo }) {
      const { tab } = useTabInfo();
      const prefs = useRef(loadPrefs()).current;
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [query, setQuery] = useState("");
      const [filter, setFilter] = useState(prefs.filter ?? "all");
      const [sort, setSort] = useState(prefs.sort ?? "port");
      const [includeUdp, setIncludeUdp] = useState(prefs.includeUdp === true);
      const [showProtected, setShowProtected] = useState(prefs.showProtected !== false);
      const [autoRefresh, setAutoRefresh] = useState(prefs.autoRefresh ?? 0);
      const [expanded, setExpanded] = useState(null);
      const [toastText, setToastText] = useState(null);
      const [menuOpen, setMenuOpen] = useState(false);
      const aliveRef = useRef(true);
      const toastTimer = useRef(null);

      const toast = useCallback((text) => {
        setToastText(text);
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToastText(null), 2_600);
      }, []);

      useEffect(() => () => {
        aliveRef.current = false;
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      }, []);

      useEffect(() => {
        savePrefs({ filter, sort, includeUdp, showProtected, autoRefresh });
      }, [filter, sort, includeUdp, showProtected, autoRefresh]);

      const load = useCallback(async (force) => {
        setLoading(true);
        try {
          const value = await api("list", { includeUdp, force: force === true });
          if (!aliveRef.current) return;
          setData(value);
          setError(null);
        } catch (loadError) {
          if (aliveRef.current) setError(loadError.message);
        } finally {
          if (aliveRef.current) setLoading(false);
        }
      }, [includeUdp]);

      useEffect(() => {
        load(false);
      }, [load]);

      useEffect(() => {
        if (autoRefresh <= 0) return undefined;
        const timer = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) return;
          load(true);
        }, autoRefresh);
        return () => clearInterval(timer);
      }, [autoRefresh, load]);

      // tab 由隐藏变可见时刷新一次：切回来看到的不是旧数据。
      useEffect(() => {
        if (tab.visible === true) load(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab.visible]);

      const ports = data?.ports ?? [];
      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = ports.filter((entry) => {
          if (!showProtected && entry.protected) return false;
          if (filter === "local" && entry.scope !== "local") return false;
          if (filter === "exposed" && entry.scope === "local") return false;
          if (filter === "killable" && !entry.killable) return false;
          if (needle === "") return true;
          const haystack = [
            String(entry.port),
            entry.app.title,
            entry.app.detail,
            entry.name,
            entry.command,
            entry.cwd ?? "",
            entry.container?.name ?? "",
            entry.wellKnown ?? "",
          ].join(" ").toLowerCase();
          return haystack.includes(needle);
        });
        const sorted = [...filtered];
        if (sort === "app") sorted.sort((left, right) => left.app.title.localeCompare(right.app.title) || left.port - right.port);
        else if (sort === "cpu") sorted.sort((left, right) => (right.cpu ?? 0) - (left.cpu ?? 0) || left.port - right.port);
        else if (sort === "mem") sorted.sort((left, right) => (right.rssBytes ?? 0) - (left.rssBytes ?? 0) || left.port - right.port);
        return sorted;
      }, [ports, query, filter, sort, showProtected]);

      const FILTERS = [
        ["all", "全部"],
        ["local", "仅本机"],
        ["exposed", "对外暴露"],
        ["killable", "可结束"],
      ];
      const stats = data?.stats;

      return h("div", { className: "pgm-root", "data-port-manager-tab": tab.id },
        h("div", { className: "pgm-head" },
          h("div", { className: "pgm-head-top" },
            h("span", { className: "pgm-title" }, h(IconPlug, { size: 15 }), "Port Manager"),
            h("span", { className: "pgm-count", title: data?.scannedAt ?? "" },
              loading && data === null
                ? "正在扫描…"
                : `${visible.length}/${ports.length} 个端口 · ${stats?.apps ?? 0} 个应用`
                  + (stats?.exposed > 0 ? ` · ${stats.exposed} 个对外` : "")
                  + (typeof data?.scannedAt === "string" ? ` · ${formatAgo(data.scannedAt)}` : "")),
            h("button", {
              type: "button",
              className: "pgm-iconbtn",
              "data-spin": loading ? "1" : "0",
              onClick: () => load(true),
              title: "重新扫描",
              "aria-label": "重新扫描",
            }, h(IconRefresh, { size: 15 })),
            h("div", { className: "pgm-menu" },
              h("button", {
                type: "button",
                className: "pgm-iconbtn",
                onClick: () => setMenuOpen((value) => !value),
                title: "更多",
                "aria-label": "更多",
              }, h("span", { style: { fontSize: 15, lineHeight: 1 } }, "⋯")),
              menuOpen && h("div", { className: "pgm-menu-list", style: { left: "auto", right: 0 } },
                h("button", {
                  type: "button",
                  className: "pgm-menu-item",
                  onClick: async () => {
                    setMenuOpen(false);
                    toast(await copyText(exportMarkdown(visible)) ? `已复制 ${visible.length} 条端口清单` : "复制失败");
                  },
                }, "复制端口清单（Markdown）"),
                h("button", {
                  type: "button",
                  className: "pgm-menu-item",
                  onClick: async () => {
                    setMenuOpen(false);
                    const text = visible.map((entry) => `:${entry.port} ${entry.app.title} (pid ${entry.pid})`).join("\n");
                    toast(await copyText(text) ? "已复制端口与进程" : "复制失败");
                  },
                }, "复制端口 + 进程列表"),
                h("button", {
                  type: "button",
                  className: "pgm-menu-item",
                  onClick: () => {
                    setMenuOpen(false);
                    load(true);
                  },
                }, "立即刷新")))),
          h("div", { style: { position: "relative" } },
            h("span", {
              style: {
                position: "absolute", left: 8, top: 6, display: "flex",
                color: "var(--dsw-alias-label-tertiary,#8a8f98)",
              },
            }, h(IconSearch, { size: 13 })),
            h("input", {
              className: "pgm-search",
              placeholder: "搜索端口 / 应用 / 命令 / 目录",
              value: query,
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
            })),
          h("div", { className: "pgm-chips" },
            FILTERS.map(([value, label]) => h("button", {
              key: value,
              type: "button",
              className: "pgm-chip",
              "data-on": filter === value ? "1" : "0",
              onClick: () => setFilter(value),
            }, label)),
            h("span", { className: "pgm-spacer" }),
            h("button", {
              type: "button",
              className: "pgm-chip",
              "data-on": includeUdp ? "1" : "0",
              onClick: () => setIncludeUdp((value) => !value),
              title: "UDP 没有 LISTEN 状态，默认只看 TCP",
            }, "UDP"),
            h("button", {
              type: "button",
              className: "pgm-chip",
              "data-on": showProtected ? "1" : "0",
              onClick: () => setShowProtected((value) => !value),
              title: "系统 / 受保护的监听（AirPlay、系统守护进程等）",
            }, "系统项"),
            h("select", {
              className: "pgm-select",
              value: sort,
              onChange: (event) => setSort(event.target.value),
              title: "排序方式",
            },
              h("option", { value: "port" }, "按端口"),
              h("option", { value: "app" }, "按应用"),
              h("option", { value: "cpu" }, "按 CPU"),
              h("option", { value: "mem" }, "按内存")),
            h("select", {
              className: "pgm-select",
              value: String(autoRefresh),
              onChange: (event) => setAutoRefresh(Number(event.target.value)),
              title: "自动刷新",
            },
              h("option", { value: "0" }, "手动刷新"),
              h("option", { value: "3000" }, "每 3 秒"),
              h("option", { value: "10000" }, "每 10 秒"),
              h("option", { value: "30000" }, "每 30 秒"))),
          error !== null && h("div", { className: "pgm-err" }, `扫描失败：${error}`),
          Array.isArray(data?.warnings) && data.warnings.length > 0
            && h("div", { className: "pgm-warn" }, data.warnings.join("；"))),
        h("div", { className: "pgm-body" },
          loading && data === null && h("div", { className: "pgm-list" },
            h("div", { className: "pgm-skel" }), h("div", { className: "pgm-skel" }), h("div", { className: "pgm-skel" })),
          data !== null && visible.length === 0 && h("div", { className: "pgm-state" },
            h("h4", null, ports.length === 0 ? "没有扫描到监听端口" : "没有匹配的端口"),
            h("div", null, ports.length === 0
              ? "本机当前没有进程在监听 TCP 端口（可以试试打开 UDP 开关）。"
              : "换个关键词，或把筛选切回“全部”。")),
          data !== null && h("ul", { className: "pgm-list" },
            visible.map((entry) => h(PortCard, {
              key: entry.key,
              entry,
              expanded: expanded === entry.key,
              onToggle: setExpanded,
              onRefresh: () => load(true),
              toast,
            }))),
          toastText !== null && h("div", { className: "pgm-toast" }, toastText)));

    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    /** 需要的客户端服务：插槽系统与右侧栏页签注册表。 */
    const inject = ["slots", "sidebarRightTabs"];

    /**
     * 客户端插件主体：注册页面类型、guide 入口、tab 主体与 tab 标题。
     * @param {object} ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: PORT_MANAGER_ID,
        kind: PORT_MANAGER_KIND,
        // 页面类型不声明 patterns：它按 kind 打开，不认领任何资源地址。
        priority: "extension",
        title: () => "Port Manager",
        guide: [{
          order: 30,
          title: () => "Port Manager",
          description: () => "查看本机监听端口、占用它的应用，并直接结束进程",
          icon: IconPlug,
        }],
      }), "port-manager: 页签类型");

      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: PORT_MANAGER_ID,
      }, PortManagerBody)), "port-manager: 页签主体");

      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
        name: "sidebar.right.pane.tab.title",
        key: PORT_MANAGER_ID,
      }, function PortManagerTitle({ useTabInfo }) {
        const { tab } = useTabInfo();
        return h(React.Fragment, null, h(IconPlug, { size: 14 }), tab.title);
      })), "port-manager: 页签标题");
    }

    exports.apply = apply;
    exports.inject = inject;
    // 测试接缝：浏览器运行时只读 apply / inject，这里给 node --test 暴露纯函数与
    // 组件，用来在无浏览器环境下断言渲染结果（见 test/client.test.mjs）。
    exports.__internals = {
      PORT_MANAGER_ID,
      PORT_MANAGER_KIND,
      PortManagerBody,
      PortCard,
      CopyMenu,
      copyChoices,
      exportMarkdown,
      formatElapsed,
      formatBytes,
      formatAgo,
      api,
    };
    return module.exports;
  },
});
