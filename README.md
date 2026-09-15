# dsh-port-manager

> dsh 原生侧边栏应用：**本机现在开着哪些端口、是谁占的、一句话把它处理掉。**

一个纯本地、零运行时依赖的 dsh web 插件。它把自己注册成**右侧栏的原生 page 类型 tab**
（走 `ctx.sidebarRightTabs` + `sidebar.right.pane.tab` 插槽，和官方「文件」页同一套机制），
数据由插件自己的宿主半用 `lsof` / `ps` 采集后经围栏 JSON 接口送到面板。

```
打开右侧栏  →  点 guide 里的 “Port Manager” 胶囊  →  端口列表
```

---

## 功能

**1. 侧边栏入口**
在右侧栏的 guide 页贡献一枚 「Port Manager」 胶囊（order 30，图标为插头），点开即在
当前分栏打开应用；tab 胶囊自带图标，可拖拽 / 分栏 / 浮动 / 全屏，全部由 dsh 原生机制负责。

**2. 端口全貌 + 占用它的应用**
每个监听一条卡片，展示：

| 字段 | 说明 |
| --- | --- |
| 端口 / 协议 | `:3080`、TCP（可选 UDP） |
| 绑定范围 | **仅本机**（回环）/ **局域网**（指定网卡）/ **所有网卡**（对外暴露，橙色警示） |
| 应用 | 友好名：`.app` 包名、`node · vite`、`python · http.server`、Docker 容器名…… 并标注类别（Node / Python / Docker / 应用 / 服务 / 进程） |
| 进程 | PID、所属用户、已运行时长、CPU、内存 |
| 工作目录 | 进程 cwd（一行路径，可点开访达） |
| 常见用途 | `:5173 Vite dev`、`:5432 PostgreSQL`、`:7000 macOS AirPlay 接收器` 这类提示 |
| 容器 | 命中 `docker ps` 端口映射时显示容器名与镜像 |

顶部还有：`可见/总数 个端口 · N 个应用 · M 个对外 · 上次扫描时间`、搜索框（端口 / 应用 /
命令 / 目录 / 容器名）、筛选（全部 / 仅本机 / 对外暴露 / 可结束）、开关（UDP、系统项）、
排序（端口 / 应用 / CPU / 内存）、自动刷新（手动 / 3s / 10s / 30s，切回 tab 时也会自动刷新一次）。

**3. 每个端口下方的常用操作**

| 操作 | 行为 |
| --- | --- |
| **打开** | 用系统默认浏览器打开 `http://localhost:<port>`（TLS 端口走 https） |
| **复制** | 菜单：`localhost:port` / `http://localhost:port` / `:port` / `lsof -i :port` / `kill <pid>` / 工作目录 / 启动命令 |
| **详情** | 展开进程详情：完整命令行（点击即复制）、cwd、父进程链、监听绑定明细、容器；内含 **HTTP 探测**（状态码、Server、X-Powered-By、Content-Type、页面标题、耗时） |
| **定位** | 在访达（Linux 为文件管理器）里打开该进程的工作目录 |
| **结束** | 二次确认后就地结束：先 `SIGTERM`，1.7 秒没退出自动升级 `SIGKILL`；也可直接「强制 -9」 |

右上角 `⋯` 还能一键**复制端口清单（Markdown 表格）**或**端口 + 进程列表**，方便直接贴进对话里让模型排查。

---

## 安装

插件目录已在本机，用 dsh 自己的插件命令装进 `web` profile：

```bash
cd /path/to/dsh-PortManager        # 本插件目录
dsh plugin --profile web add "link:$PWD"
```

该命令是 pnpm 的转发器，装完会把 `dsh-port-manager` 追加进 profile 的
`dsh.profile.bundles`（因为本包含 `dsh.bundle.patch`）。**新增 bundle 层需要重启 `dsh web`**；
之后只改 `lib/client.js` 时会由客户端 HMR 触发重载，不必重启。

验证：

```bash
node -e 'const p=require(process.env.HOME+"/.dsh/profiles/web/package.json");console.log(p.dependencies["dsh-port-manager"], p.dsh.profile.bundles)'
```

---

## 架构

```
lib/
├── index.js    宿主半：零依赖对象插件（export apply/inject），注册 /port-manager/api 围栏路由
├── scan.js     扫描与解析：lsof / ps / ss / docker ps → 结构化端口记录（纯函数可单测）
└── client.js   浏览器半：window.__ModuleLoader__ bundle，注册原生 tab 类型 + 面板 UI
test/           node --test：解析单测、路由单测、bundle 注册与真实渲染断言、真实 cordis 集成
scripts/        integration-scenario.mjs：集成场景脚本（真 cordis + 真 webServer + 真 HTTP）
```

数据流：面板 `fetch("/port-manager/api/<method>")` → 宿主半 `execFile` 调系统命令 → 解析成
端口记录 → JSON 信封返回。宿主半带 1.2s 扫描缓存与并发合并，自动刷新不会把 `lsof` 打满。

| 接口 | 用途 |
| --- | --- |
| `list` | 扫描端口（`includeUdp` / `force` / `docker` 可选） |
| `detail` | 单进程详情（命令行、cwd、父进程链、它占用的端口） |
| `kill` | 结束进程（先校验「它确实还在监听这个端口」） |
| `open` | 系统浏览器打开 |
| `reveal` | 文件管理器打开目录 |
| `probe` | 本机 HTTP(S) 探测 |

### 依赖说明

- **宿主半零 import**：只用 `node:fs` / `node:http` / `node:https` / `node:child_process`
  加同目录的 `./scan.js`。所以插件目录**不需要 `node_modules`**（`link:` 安装后即可加载），
  也不会踩「裸 import 从插件目录解析不到」的坑。要加 `@deepseek-ai/*` 依赖前请先读这一条。
- **浏览器半只 `require("react")`**：图标全部内联 SVG、样式自己注入 `<style data-plugin-css>`，
  不 require 任何非种子包（那会以 `missed the module table` 炸掉整个 bundle）。
- 外部命令只用系统自带的 `lsof` / `ps` / `open`（Linux 回退 `ss` / `xdg-open`），
  可选 `docker ps`（仅在 `docker.sock` 存在时调用）。

---

## 安全边界

`kill` 是这个插件的特权面，因此：

1. **浏览器围栏**：`/port-manager/api` 是插件自己注册的裸 `node:http` 路由，**不经过 dsh 的
   `/api` 网关**，没有自带的 Host/Origin 校验与鉴权 Cookie。所以宿主半复刻了与网关一致的
   loopback / trustedHosts / 同源 / `sec-fetch-site` 检查，非可信来源一律 403。
2. **结束前再校验**：列表可能是几秒前扫出来的，PID 可能已被系统复用。`kill` 会重新用
   `lsof -iTCP:<port> -sTCP:LISTEN` 确认该 PID 此刻仍在监听这个端口，并用 `ps` 核对 uid。
3. **只杀自己的进程**：非当前用户、系统账号（root / `_windowserver` / …）、系统目录里的
   可执行文件（`/System`、`/usr/libexec`、`/usr/sbin`…）、macOS 的 ControlCenter（AirPlay
   占着 5000/7000）、以及 **DSH 自己监听的端口**（结束了当前界面也会没）都会被标成受保护，
   结束按钮直接禁用并显示原因。
4. 受保护/不可结束的条目在 UI 上带锁图标，`refused` / `not-listening` 等错误会在面板内以
   toast 原文回显，不会静默失败。

---

## 开发

```bash
node --test        # 27 个用例：解析 / 路由 / 围栏 / bundle 注册 / 组件渲染 / 真实 cordis 集成
node --check lib/index.js && node --check lib/scan.js && node --check lib/client.js
```

`test/host.test.mjs` 用假 ctx 抓路由 handler 打假 req/res；`test/integration.test.mjs`（配
`scripts/integration-scenario.mjs`）更进一步：它在子进程里起**真的 cordis Context + 真的
`dsh-host-webserver`**，把插件 `apply` 挂进真实服务树，再用真实 HTTP 请求验证围栏（异源 / 跨站
403、同源放行）、方法分发与真实扫描结果。

`test/client.test.mjs` 用假的 `window.__ModuleLoader__` + 假 ctx 装载 bundle，并用
`react-dom/server` 把面板真渲染成 HTML（React 从本机 profile 或兄弟插件的 `node_modules`
里按路径解析；找不到就跳过渲染断言），因此端口卡片是真的渲染成 HTML 后被断言的。

改 UI 只动 `lib/client.js`，保存后由 `dsh-client-hmr` 推到已打开的页面；改宿主半
（路由/扫描）需要重启 `dsh web`，或把 insert 行临时写进 profile 的 `cordis.patch.yml`
（该文件是 live 重载的）。

---

## 已知限制

- **UDP 没有 LISTEN 状态**：默认只看 TCP，UDP 需要手动打开开关（`lsof -iUDP`）。
- **别人的进程只能看不能杀**：非当前用户的监听会列出但按钮禁用（`kill` 也会 403）。
- **工作目录读不到就没有「定位」**：同用户进程一般可读，系统进程不可读。
- **端口清单是快照**：没有 fs 事件，需要自动刷新或手动刷新；扫描一次约 0.6s（含 docker 查询）。
- **面板很窄时**（<320px）操作按钮会折行，这是原生面板宽度决定的，把面板拖宽或全屏即可。

## 许可

MIT
