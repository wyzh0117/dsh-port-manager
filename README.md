# dsh-port-manager

> A native DSH sidebar app: **which ports this machine is listening on, which app owns each one, and one click to deal with it.**

**English** · [中文](README.zh.md)

A local-only, zero-runtime-dependency plugin for the DSH web client. It registers itself as a
**native right-sidebar page tab** (through `ctx.sidebarRightTabs` + the keyed
`sidebar.right.pane.tab` slot — the same mechanism the shipped Files page uses), and the data it
renders is collected by its own host half with `lsof` / `ps` and delivered over a fenced JSON API.

**Keywords:** `dsh` · `deepseek-harness` · `plugin` · `sidebar` · `port` · `lsof` · `port-manager`

**At a glance:** MIT · DSH `^0.1.5-rc.1` · Node `>= 20` · macOS · Linux · no `dependencies`

```
Open the right sidebar  →  click the “Port Manager” capsule in the guide  →  the port list
```

---

## Features

> **Language note.** The panel UI ships in **Simplified Chinese only** — there is no i18n layer yet.
> This README uses English glosses for its labels, and gives the actual caption in parentheses the
> first time a control is named.

### 1. Sidebar entry

One guide capsule (`order 15`, plug glyph) in the right sidebar's guide page. Clicking it opens the
app in the active pane; the tab chip carries its own icon, and splitting, floating and fullscreen are
handled by the native docking kit.

### 2. Every listening port, and the app behind it

One card per listener:

| Field | What it shows |
| --- | --- |
| Port / protocol | `:3080`, TCP (UDP behind a toggle) |
| Bind scope | **loopback only** / **LAN** (a named interface) / **all interfaces** (exposed — orange warning) |
| App | Friendly name: `.app` bundle name, `node · vite`, `python · http.server`, Docker container… plus a category badge (Node / Python / Docker / App / Service / Process) |
| Process | PID, owning user, uptime, CPU, memory |
| Working directory | The process cwd, on one line (open it from the **定位 / Reveal** button) |
| Well-known port | Hints such as `:5173 Vite dev`, `:5432 PostgreSQL` |
| Container | Container name and image when a `docker ps` port mapping matches |

The toolbar carries: the `visible/total ports · N apps · M exposed · last scan time` summary, a search
box (port / app / command / directory / container name), filters (全部 all / 仅本机 loopback /
对外暴露 exposed / 可结束 killable), toggles (UDP, system entries), sorting (port / app / CPU /
memory) and auto-refresh (manual / 3s / 10s / 30s, plus one refresh whenever the tab regains focus).

### 3. Per-port actions

| Action | Behaviour |
| --- | --- |
| **打开 / Open** | Opens `http://localhost:<port>` in the system browser (TLS ports go to https) |
| **复制 / Copy** | Menu: `localhost:port` / `http://localhost:port` / `:port` / `lsof -i :port` / `kill <pid>` / working directory / launch command |
| **详情 / Details** | Expands the process view: full command line (click to copy), cwd, parent chain, every listening binding, container — plus an **HTTP probe** reporting status code, `Server`, `X-Powered-By`, `Content-Type`, page title and latency |
| **定位 / Reveal** | Opens the process working directory in Finder (the file manager on Linux) |
| **结束 / Kill** | After a second confirmation: `SIGTERM` first, escalating to `SIGKILL` automatically if the process is still alive 1.7s later. A direct force `-9` is also available |

The `⋯` menu refreshes the list immediately (立即刷新) and copies the whole port list as a Markdown
table, or as `:port app (pid)` lines — handy for pasting straight into a conversation and asking a
model to look at it.

---

## Install

```bash
cd /path/to/dsh-PortManager        # this plugin directory
dsh plugin --profile web add "link:$PWD"
```

The command is a thin pnpm forwarder. Because this package declares `dsh.bundle.patch`, the package
name is appended to the profile's `dsh.profile.bundles`. **A new bundle layer needs a `dsh web`
restart**; afterwards, edits to `lib/client.js` alone are pushed to an open page by the client HMR
driver, with no restart.

Verify the install:

```bash
node -e 'const h=process.env.DSH_HOME??process.env.HOME+"/.dsh";const p=require(h+"/profiles/web/package.json");console.log(p.dependencies["dsh-port-manager"], p.dsh.profile.bundles)'
```

(`dsh --profile` documents the profile directory as `$DSH_HOME/profiles`, which defaults to
`~/.dsh/profiles`.)

Uninstall:

```bash
dsh plugin --profile web remove dsh-port-manager
```

---

## Compatibility

### Platforms

| Platform | Scanning | Open / Reveal | Notes |
| --- | --- | --- | --- |
| **macOS** | `lsof` (+ `ps`, optional `docker ps`) | `open` | The primary, fully exercised target. Docker enrichment is detected through `/var/run/docker.sock` and `~/.docker/run/docker.sock` |
| **Linux** | `lsof`, falling back to `ss -ltnpH` / `ss -lunpH` when `lsof` is absent | `xdg-open` | Full feature parity, including Docker |
| **Windows** | `lsof` is not present and `ss` is Linux-only, so scanning reports a warning and an empty list | `cmd /c start`, `explorer` | Not a supported target: the scanning half has no Windows backend. `open` additionally rejects paths containing characters `cmd` would interpret |

### Requirements

| Requirement | Version | Where it is declared |
| --- | --- | --- |
| DSH | `^0.1.5-rc.1` | `dsh.plugin.json` → `engines.dsh` |
| Node.js | `>= 20` | `package.json` → `engines.node` |
| `@deepseek-ai/cordis` | `^4.0.1` (peer) | `package.json` → `peerDependencies` |
| React | `^18.2.0` (peer) | `package.json` → `peerDependencies` |
| External commands | `lsof`, `ps` (system-provided); optional `ss`, `docker` | — |

There are **no `dependencies`**: the host half imports only `node:fs` / `node:http` / `node:https` /
`node:child_process` / `node:os` / `node:util` plus its sibling `./scan.js`, so the plugin directory
needs no `node_modules` and works immediately after a `link:` install.

### Version adaptivity

The plugin is written so that a host or client it does not fully recognise degrades instead of
breaking. Each row below is enforced by code, not by convention:

| Surface | What the plugin does | What you get on a different version |
| --- | --- | --- |
| Host half activation | `export const inject = ["webServer"]` | On profiles with no web server (headless / CLI) the plugin simply stays dormant instead of failing to load |
| Optional host service | `ctx.get("webRuntime")?.trustedHosts ?? []` | Trusted hosts are honoured when the service exists; without it the request fence falls back to loopback-only, which is the stricter default |
| Client half activation | `export const inject = ["slots", "sidebarRightTabs"]` | A client build without the native sidebar-tab registry leaves the browser half inactive rather than throwing; the host half and its API keep working |
| Slot contract | `ctx.slots.inject(name, () => ctx.slots.register(...))` via `ctx.effect` | Slot registration is reactive and disposable: if a slot appears later, or a version renames where it is contributed, the tab registers when the slot exists and is torn down when it goes away |
| Design tokens | Every token is read as `var(--dsw-alias-*, <literal fallback>)` | A renamed or missing token degrades to a readable hard-coded colour instead of an unstyled panel, and light/dark themes follow the host automatically |
| Module table | The bundle `require`s **only** `react` | Icons are inline SVG and styles ship through one `<style data-plugin-css>` tag. No bare imports means no `node_modules` resolution and no “missed the module table” bundle failure |
| Package manager | A `.gitignore`d, dependency-free tree | `link:`, a tarball or npm all install the same bytes; nothing has to be built first |
| Command availability | `which` on POSIX, `where` on Windows; `lsof` → `ss` fallback | A missing scanner produces a `warnings` entry on the panel, never a crash |

---

## Architecture

```
lib/
├── index.js     host half — zero-dependency object plugin (export apply/inject), fenced /port-manager/api route
├── scan.js      scanning — lsof / ps / ss / docker ps → structured port records (pure, unit-tested)
└── client.js    browser half — a window.__ModuleLoader__ bundle registering the tab type + panel UI
test/            node --test: parsers, route + fence, bundle registration, real rendering assertions
scripts/         integration-scenario.mjs — real cordis Context + real dsh-host-webserver over real HTTP
```

The panel `fetch`es `/port-manager/api/<method>`; the host half uses `execFile`, parses the output
into port records and wraps them in a JSON envelope. Scans are cached for 1.2s with in-flight
coalescing, so an auto-refresh interval never hammers `lsof`.

| Endpoint | Purpose |
| --- | --- |
| `list` | Scan ports (`includeUdp` / `force` / `docker` optional) |
| `detail` | One process in full (command line, cwd, parent chain, the ports it holds) |
| `kill` | End a process (after re-verifying that it really still listens on that port) |
| `open` | Open in the system browser |
| `reveal` | Open a directory in the file manager |
| `probe` | Local HTTP(S) probe |

---

## Security boundary

`kill` is this plugin's privileged surface, so:

1. **Browser fence.** `/port-manager/api` is a raw `node:http` route registered by the plugin — it
   bypasses DSH's `/api` gateway and therefore does not inherit its Host/Origin check or auth cookie.
   The host half re-implements the same loopback / `trustedHosts` / same-origin / `sec-fetch-site`
   checks, and answers 403 to anything untrusted.
2. **Re-verified before terminating.** The list may be seconds old and PIDs get reused. `kill` asks
   `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` again to confirm that this PID is listening on this port
   right now, and cross-checks the uid with `ps`.
3. **The protection policy is enforced server-side** — a greyed-out button is not a security
   boundary. Refused (403 `refused`) are: other users' processes, system accounts
   (root / `_windowserver` / …), executables under system directories (`/System`, `/usr/libexec`, …),
   macOS ControlCenter (AirPlay holds 5000/7000), the **DSH host's own process chain** — the plugin
   lives inside the host process, so killing an ancestor would take the UI down with it; this is
   decided from `process.pid`'s ancestry, never from the request's `Host` header — and the DSH port
   the request itself came from.
4. Protected and unkillable entries carry a lock icon in the UI, and errors such as `refused` /
   `not-listening` are echoed verbatim as a toast in the panel. Nothing fails silently.

---

## Development

```bash
node --test        # 32 cases: parsers / route / fence / bundle registration / component rendering / real cordis integration
node --check lib/index.js && node --check lib/scan.js && node --check lib/client.js
```

`test/host.test.mjs` drives the route handler with a fake `ctx` and fake `req`/`res`.
`test/integration.test.mjs` (with `scripts/integration-scenario.mjs`) goes further: it boots a **real
cordis Context and a real `dsh-host-webserver`** in a child process, mounts the plugin's `apply` into
the live service tree, and verifies the fence (cross-origin 403, same-origin pass), method dispatch
and real scan results over real HTTP.

`test/client.test.mjs` loads the bundle against a fake `window.__ModuleLoader__` and a fake `ctx`,
then renders the panel to HTML with `react-dom/server` (React is resolved by path from the local
profile or a sibling plugin's `node_modules`; the rendering assertions are skipped when it cannot be
found). The port cards really are rendered to HTML and then asserted on.

To change the UI, edit `lib/client.js` only — saving pushes the change into open pages through
`@deepseek-ai/dsh-client-hmr`. Changing the host half (routes / scanning) needs a `dsh web` restart, or
temporarily adding the insert row to the profile's `cordis.patch.yml` (that file is live-reloaded).

---

## Known limitations

- **UDP has no LISTEN state** — only TCP is scanned by default; UDP needs the toggle (`lsof -nP -iUDP`).
- **Other users' processes are visible but not killable** — they are listed, the buttons are
  disabled, and `kill` answers 403.
- **No cwd means no “Reveal”** — readable for same-user processes, not for system ones.
- **The list is a snapshot** — there is no filesystem event feed, so it relies on auto-refresh or a
  manual refresh. One scan costs roughly 0.6s including the Docker query.
- **Narrow panels** (under ~320px) wrap the action buttons; that is the native panel width, so drag
  the panel wider or go fullscreen.

---

## Contributing

Issues and pull requests are welcome at
<https://github.com/wyzh0117/dsh-port-manager/issues>.

Before opening a PR:

```bash
node --test && node --check lib/index.js && node --check lib/scan.js && node --check lib/client.js
```

Please keep the two constraints that make this plugin installable without a build step:

- the host half (`lib/index.js`, `lib/scan.js`) imports nothing but `node:*` and `./scan.js`;
- the browser half (`lib/client.js`) requires nothing from the module table except `react`.

Adding a bare `import` of an `@deepseek-ai/*` package to either half breaks a `link:` install and the
browser bundle respectively.

## Changelog

### 0.1.0

- Native right-sidebar page tab: guide capsule, keyed `sidebar.right.pane.tab` body, and a tab title
  with its own icon.
- Port scanning through `lsof` (with an `ss` fallback) plus `ps` enrichment, Docker container
  mapping, well-known-port hints, search / filters / sorting / auto-refresh.
- Per-port Open / Copy / Details (with HTTP probe) / Reveal / Kill, with `SIGTERM` → `SIGKILL`
  escalation and a server-side protection policy.
- 32 tests, including a real-cordis integration scenario over real HTTP.

## Acknowledgements

Built against the DSH plugin API of `@deepseek-ai/dsh` `0.1.5-rc.*`, following the same conventions
as the shipped sidebar pages. Thanks to the DSH plugin community for the reference implementations
that made the native-tab wiring legible.

## License

[MIT](LICENSE) © 2026 dsh-port-manager contributors

---

<sub>If this plugin saved you a <code>lsof</code> lookup, a star helps other people find it.</sub>

[![Star History Chart](https://api.star-history.com/svg?repos=wyzh0117/dsh-port-manager&type=Date)](https://star-history.com/#wyzh0117/dsh-port-manager&Date)
