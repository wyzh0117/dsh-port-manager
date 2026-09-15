# docs/research

这两份报告是开发本插件时对 dsh（DeepSeek Harness 0.1.5-rc.2）插件 API 做的源码级调研，
由两个独立的研究 agent 产出，**每一条结论都带 `包名/文件:行号` 证据**。它们不是用户文档，
但如果以后要改这个插件、或者给 dsh 写别的插件，这两份东西比翻源码快得多。

| 文件 | 内容 |
| --- | --- |
| `DSH-NATIVE-SIDEBAR-TAB-RECIPE.md` | 原生右侧栏 page 类型 tab 的完整注册配方：`window.__ModuleLoader__` 入口格式、模块表种子词、`ctx.sidebarRightTabs.register` 的字段语义、`sidebar.right.pane.tab` 插槽契约、guide 胶囊与默认页的判定规则、`dsh.client` 声明要求，以及一份最小可用的 `lib/client.js` |
| `DSH-PLUGIN-RECIPE.md` | 宿主半配方：cordis 插件形态（`export function apply` vs `Service` 子类）、`ctx.webServer.register` 前缀路由与浏览器信任围栏、为什么用 `node:child_process` 而不是 `ctx.shell`、客户端 bundle 的发现与加载规则、`dsh plugin add link:` 的安装与 reconcile 行为、重启与热重载的真实边界，以及踩坑清单 |

## 与代码的对应关系

- 浏览器半的注册方式 → `DSH-NATIVE-SIDEBAR-TAB-RECIPE.md` §2 / §3 / §7
- 宿主半的路由与围栏 → `DSH-PLUGIN-RECIPE.md` §1.4 / §2.2 / §2.3
- 安装与生效路径 → `DSH-PLUGIN-RECIPE.md` §5（含 `dsh.profile.bundles` 与
  `cordis.patch.yml` 的分工：**两者都要**，前者列层、后者才是 insert 行）

## 注意

报告里标注为 UNVERIFIED 的条目（例如手动往 profile `cordis.patch.yml` 加 insert 行能否热挂载
一个「已安装但未进 bundles」的包）在写代码时**没有**被依赖：本插件的实现只走已被实测的路径
（bundle patch 里的 insert 行 + 重启），并且 `test/` 下的 27 个用例把这些结论都变成了可执行断言。
