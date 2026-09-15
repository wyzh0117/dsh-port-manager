# dsh-port-manager

> dsh 原生侧边栏应用：**本机现在开着哪些端口、是谁占的、一句话把它处理掉。**

[English](README.md) · **中文**

一个纯本地、零运行时依赖的 dsh web 插件。它把自己注册成**右侧栏的原生 page 类型 tab**
（走 `ctx.sidebarRightTabs` + 带 key 的 `sidebar.right.pane.tab` 插槽，和官方「文件」页同一套机制），
数据由插件自己的宿主半用 `lsof` / `ps` 采集后经围栏 JSON 接口送到面板。

**关键词：** `dsh` · `deepseek-harness` · `plugin` · `sidebar` · `port` · `lsof` · `port-manager`

**基本信息：** MIT · DSH `^0.1.5-rc.1` · Node `>= 20` · macOS · Linux · 无 `dependencies`

```
打开右侧栏  →  点 guide 里的 “Port Manager” 胶囊  →  端口列表
```

---

## 功能

### 1. 侧边栏入口

在右侧栏的 guide 页贡献一枚「Port Manager」胶囊（`order 15`，图标为插头），点开即在当前分栏
打开应用；tab 胶囊自带图标，可拖拽 / 分栏 / 浮动 / 全屏，全部由 dsh 原生机制负责。

### 2. 端口全貌 + 占用它的应用

每个监听一条卡片，展示：

| 字段 | 说明 |
| --- | --- |
| 端口 / 协议 | `:3080`、TCP（UDP 需手动开开关） |
| 绑定范围 | **仅本机**（回环）/ **局域网**（指定网卡）/ **所有网卡**（对外暴露，橙色警示） |
| 应用 | 友好名：`.app` 包名、`node · vite`、`python · http.server`、Docker 容器名…… 并标注类别（Node / Python / Docker / 应用 / 服务 / 进程） |
| 进程 | PID、所属用户、已运行时长、CPU、内存 |
| 工作目录 | 进程 cwd（一行路径，用「定位」按钮打开） |
| 常见用途 | `:5173 Vite dev`、`:5432 PostgreSQL`、`:7000 macOS AirPlay 接收器` 这类提示 |
| 容器 | 命中 `docker ps` 端口映射时显示容器名与镜像 |

顶部还有：`可见/总数 个端口 · N 个应用 · M 个对外 · 上次扫描时间`、搜索框（端口 / 应用 /
命令 / 目录 / 容器名）、筛选（全部 / 仅本机 / 对外暴露 / 可结束）、开关（UDP、系统项）、
排序（端口 / 应用 / CPU / 内存）、自动刷新（手动 / 3s / 10s / 30s，切回 tab 时也会自动刷新一次）。

### 3. 每个端口下方的常用操作

| 操作 | 行为 |
| --- | --- |
| **打开** | 用系统默认浏览器打开 `http://localhost:<port>`（TLS 端口走 https） |
| **复制** | 菜单：`localhost:port` / `http://localhost:port` / `:port` / `lsof -i :port` / `kill <pid>` / 工作目录 / 启动命令 |
| **详情** | 展开进程详情：完整命令行（点击即复制）、cwd、父进程链、监听绑定明细、容器；内含 **HTTP 探测**（状态码、Server、X-Powered-By、Content-Type、页面标题、耗时） |
| **定位** | 在访达（Linux 为文件管理器）里打开该进程的工作目录 |
| **结束** | 二次确认后就地结束：先 `SIGTERM`，1.7 秒没退出自动升级 `SIGKILL`；也可直接「强制 -9」 |

右上角 `⋯` 可**立即刷新**，也能一键**复制端口清单（Markdown 表格）**或**端口 + 进程列表**，方便直接贴进对话里让模型排查。

---

## 安装

```bash
cd /path/to/dsh-PortManager        # 本插件目录
dsh plugin --profile web add "link:$PWD"
```

该命令是 pnpm 的转发器，装完会把 `dsh-port-manager` 追加进 profile 的 `dsh.profile.bundles`
（因为本包含 `dsh.bundle.patch`）。**新增 bundle 层需要重启 `dsh web`**；之后只改 `lib/client.js`
时会由客户端 HMR 触发重载，不必重启。

验证：

```bash
node -e 'const h=process.env.DSH_HOME??process.env.HOME+"/.dsh";const p=require(h+"/profiles/web/package.json");console.log(p.dependencies["dsh-port-manager"], p.dsh.profile.bundles)'
```

（`dsh --profile` 的说明里 profile 目录就是 `$DSH_HOME/profiles`，未设置时默认 `~/.dsh/profiles`。）

卸载：

```bash
dsh plugin --profile web remove dsh-port-manager
```

---

## 兼容性

### 平台

| 平台 | 扫描 | 打开 / 定位 | 说明 |
| --- | --- | --- | --- |
| **macOS** | `lsof`（+ `ps`，可选 `docker ps`） | `open` | 主要且完整验证过的目标平台。Docker 信息通过 `/var/run/docker.sock` 与 `~/.docker/run/docker.sock` 探测 |
| **Linux** | `lsof`，缺失时回退 `ss -ltnpH` / `ss -lunpH` | `xdg-open` | 功能对齐，含 Docker |
| **Windows** | 没有 `lsof`，`ss` 又是 Linux 专有，扫描会给出警告并返回空列表 | `cmd /c start`、`explorer` | **非支持目标**：扫描半没有 Windows 后端。`open` 另外会拒绝含 `cmd` 控制符的路径 |

### 依赖要求

| 项 | 版本 | 声明位置 |
| --- | --- | --- |
| DSH | `^0.1.5-rc.1` | `dsh.plugin.json` → `engines.dsh` |
| Node.js | `>= 20` | `package.json` → `engines.node` |
| `@deepseek-ai/cordis` | `^4.0.1`（peer） | `package.json` → `peerDependencies` |
| React | `^18.2.0`（peer） | `package.json` → `peerDependencies` |
| 外部命令 | `lsof`、`ps`（系统自带）；可选 `ss`、`docker` | — |

本包**没有 `dependencies`**：宿主半只用 `node:fs` / `node:http` / `node:https` /
`node:child_process` / `node:os` / `node:util` 加同目录的 `./scan.js`。所以插件目录**不需要
`node_modules`**（`link:` 安装后即可加载），也不会踩「裸 import 从插件目录解析不到」的坑。

### 不同版本自适应

插件被写成「遇到不完整认识的宿主 / 客户端就降级，而不是坏掉」。下表的每一行都由代码保证，
不是约定：

| 面 | 插件怎么做 | 换个版本会怎样 |
| --- | --- | --- |
| 宿主半激活 | `export const inject = ["webServer"]` | 在没有 web server 的 profile（headless / CLI）下插件直接不激活，而不是加载失败 |
| 可选宿主服务 | `ctx.get("webRuntime")?.trustedHosts ?? []` | 服务存在时按可信主机列表放行；不存在时围栏退回「仅回环」，这是更严格的那一侧 |
| 浏览器半激活 | `export const inject = ["slots", "sidebarRightTabs"]` | 客户端构建里没有原生侧栏页签注册表时，浏览器半不激活而不是抛错；宿主半与它的接口照常工作 |
| 插槽契约 | `ctx.slots.inject(name, () => ctx.slots.register(...))`，包在 `ctx.effect` 里 | 插槽注册是响应式且可回收的：插槽晚一点出现、或某个版本改了贡献位置，都是「插槽在时就注册，插槽没了就拆掉」 |
| 设计 token | 每个 token 都写成 `var(--dsw-alias-*, <字面兜底值>)` | token 被改名或缺失时降级成可读的硬编码颜色，而不是整块面板失去样式；明暗主题自动跟随宿主 |
| 模块表 | bundle 只 `require("react")` | 图标全部内联 SVG、样式走一个 `<style data-plugin-css>`。没有裸 import 就既不需要 `node_modules` 解析，也不会以 “missed the module table” 炸掉整个 bundle |
| 包管理器 | 全仓库无依赖、`node_modules` 被 gitignore | `link:`、tarball、npm 装到的都是同一份字节，不需要任何构建步骤 |
| 命令可用性 | POSIX 用 `which`、Windows 用 `where`；`lsof` 缺失回退 `ss` | 扫描器缺失时在面板上给一条 `warnings`，永不崩溃 |

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

---

## 安全边界

`kill` 是这个插件的特权面，因此：

1. **浏览器围栏**：`/port-manager/api` 是插件自己注册的裸 `node:http` 路由，**不经过 dsh 的
   `/api` 网关**，没有自带的 Host/Origin 校验与鉴权 Cookie。所以宿主半复刻了与网关一致的
   loopback / trustedHosts / 同源 / `sec-fetch-site` 检查，非可信来源一律 403。
2. **结束前再校验**：列表可能是几秒前扫出来的，PID 可能已被系统复用。`kill` 会重新用
   `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` 确认该 PID 此刻仍在监听这个端口，并用 `ps` 核对 uid。
3. **保护策略在服务端强制**（不是只把按钮置灰）：非当前用户、系统账号
   （root / `_windowserver` / …）、系统目录里的可执行文件（`/System`、`/usr/libexec`…）、
   macOS 的 ControlCenter（AirPlay 占着 5000/7000）、**DSH 宿主所在进程链**
   （插件就住在宿主进程里，结束了当前界面也会一起没 —— 按 `process.pid` 的祖先链判定，
   不信任请求头里的 Host）、以及请求来源指向的 DSH 端口，全部会被 `kill` 接口拒绝（403
   `refused`），UI 上同时显示锁图标与原因。
4. 受保护/不可结束的条目在 UI 上带锁图标，`refused` / `not-listening` 等错误会在面板内以
   toast 原文回显，不会静默失败。

---

## 开发

```bash
node --test        # 32 个用例：解析 / 路由 / 围栏 / bundle 注册 / 组件渲染 / 真实 cordis 集成
node --check lib/index.js && node --check lib/scan.js && node --check lib/client.js
```

`test/host.test.mjs` 用假 ctx 抓路由 handler 打假 req/res；`test/integration.test.mjs`（配
`scripts/integration-scenario.mjs`）更进一步：它在子进程里起**真的 cordis Context + 真的
`dsh-host-webserver`**，把插件 `apply` 挂进真实服务树，再用真实 HTTP 请求验证围栏（异源 / 跨站
403、同源放行）、方法分发与真实扫描结果。

`test/client.test.mjs` 用假的 `window.__ModuleLoader__` + 假 ctx 装载 bundle，并用
`react-dom/server` 把面板真渲染成 HTML（React 从本机 profile 或兄弟插件的 `node_modules`
里按路径解析；找不到就跳过渲染断言），因此端口卡片是真的渲染成 HTML 后被断言的。

改 UI 只动 `lib/client.js`，保存后由 `@deepseek-ai/dsh-client-hmr` 推到已打开的页面；改宿主半
（路由/扫描）需要重启 `dsh web`，或把 insert 行临时写进 profile 的 `cordis.patch.yml`
（该文件是 live 重载的）。

---

## 已知限制

- **UDP 没有 LISTEN 状态**：默认只看 TCP，UDP 需要手动打开开关（`lsof -nP -iUDP`）。
- **别人的进程只能看不能杀**：非当前用户的监听会列出但按钮禁用（`kill` 也会 403）。
- **工作目录读不到就没有「定位」**：同用户进程一般可读，系统进程不可读。
- **端口清单是快照**：没有 fs 事件，需要自动刷新或手动刷新；扫描一次约 0.6s（含 docker 查询）。
- **面板很窄时**（<320px）操作按钮会折行，这是原生面板宽度决定的，把面板拖宽或全屏即可。

---

## 参与贡献

问题与 PR 都欢迎：<https://github.com/wyzh0117/dsh-port-manager/issues>。

提交 PR 前请先跑：

```bash
node --test && node --check lib/index.js && node --check lib/scan.js && node --check lib/client.js
```

请守住让它「不需要构建步骤即可安装」的两条约束：

- 宿主半（`lib/index.js`、`lib/scan.js`）除 `node:*` 与 `./scan.js` 外不 import 任何东西；
- 浏览器半（`lib/client.js`）除 `react` 外不从模块表 require 任何东西。

给任一半加一个 `@deepseek-ai/*` 的裸 import，会分别破坏 `link:` 安装和浏览器 bundle。

## 更新日志

### 0.1.0

- 原生右侧栏 page 类型 tab：guide 胶囊、带 key 的 `sidebar.right.pane.tab` 主体，以及带图标的
  tab 标题。
- 基于 `lsof`（缺失回退 `ss`）+ `ps` 富化的端口扫描，Docker 容器映射、常见端口提示、
  搜索 / 筛选 / 排序 / 自动刷新。
- 每个端口的打开 / 复制 / 详情（含 HTTP 探测）/ 定位 / 结束，`SIGTERM` → `SIGKILL` 升级与
  服务端保护策略。
- 32 个用例，含一套真 cordis、真 HTTP 的集成场景。

## 致谢

基于 `@deepseek-ai/dsh` `0.1.5-rc.*` 的插件 API 开发，沿用官方侧栏页面的同一套约定。感谢
dsh 插件社区里那些参考实现，它们让原生 tab 的接线方式变得可读。

## 许可

[MIT](LICENSE) © 2026 dsh-port-manager contributors

---

<sub>如果这个插件帮你省下了一次 <code>lsof</code>，一颗 star 能让更多人找到它。</sub>

[![Star History Chart](https://api.star-history.com/svg?repos=wyzh0117/dsh-port-manager&type=Date)](https://star-history.com/#wyzh0117/dsh-port-manager&Date)
