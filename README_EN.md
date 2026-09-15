# dsh-port-manager

> A native DSH sidebar app: **which ports this machine is listening on, which app owns each one, and one click to deal with it.**

A local-only, zero-runtime-dependency plugin for the dsh web client. It registers itself as a
**native right-sidebar page tab** (through `ctx.sidebarRightTabs` + the keyed
`sidebar.right.pane.tab` slot — the same mechanism the shipped Files page uses) and renders data
collected by its own host half via `lsof` / `ps`, delivered over a fenced JSON API.

```
Open the right sidebar → click the “Port Manager” capsule in the guide → the port list
```

## Features

1. **Sidebar entry** — one guide capsule (`order 30`, plug glyph) that opens the app in the active
   pane; the tab chip carries its own icon and supports splitting, floating and fullscreen through
   the native docking kit.
2. **Every listening port + the app behind it** — port/protocol, bind scope
   (**loopback / LAN / all interfaces**), a friendly app name (`.app` bundle, `node · vite`,
   `python · http.server`, Docker container…), PID, user, uptime, CPU, memory, working directory,
   well-known-port hints, and Docker container mapping when available. Toolbar: search, filters
   (all / loopback / exposed / killable), UDP + system toggles, sort, auto-refresh (manual/3s/10s/30s).
3. **Per-port actions** — **Open** (system browser), **Copy** (menu: `localhost:port`,
   `http://localhost:port`, `:port`, `lsof -i :port`, `kill <pid>`, cwd, launch command),
   **Details** (full command line, cwd, parent chain, bindings, container, plus an HTTP probe
   reporting status, `Server`, `X-Powered-By`, `Content-Type`, page title and latency),
   **Reveal** (open the process cwd in Finder), and **Kill** (two-step confirm: `SIGTERM`, then an
   automatic `SIGKILL` escalation after 1.7s; a direct force `-9` is also available).
   The `⋯` menu copies the whole port list as a Markdown table or as `:port app (pid)` lines.

## Install

```bash
cd /path/to/dsh-PortManager        # this plugin directory
dsh plugin --profile web add "link:$PWD"
```

The command is a thin pnpm forwarder; because this package declares `dsh.bundle.patch`, the package
name is appended to the profile's `dsh.profile.bundles`. **A new bundle layer needs a `dsh web`
restart.** Later edits to `lib/client.js` reload through the client HMR driver without a restart.

## Architecture

```
lib/index.js   host half — zero-import object plugin (export apply/inject), fenced /port-manager/api route
lib/scan.js    scanning — lsof / ps / ss / docker ps → structured port records (pure, unit-tested)
lib/client.js  browser half — a window.__ModuleLoader__ bundle registering the tab type + panel UI
test/          node --test: parsers, route + fence, bundle registration, real component rendering
scripts/       integration-scenario.mjs: real cordis Context + real dsh-host-webserver over real HTTP
```

The panel `fetch`es `/port-manager/api/<method>`; the host half shells out with `execFile`, parses
the output into port records and wraps them in a JSON envelope. Scans are cached for 1.2s with
in-flight coalescing, so auto-refresh never hammers `lsof`.

**Dependencies:** the host half imports only `node:*` plus its sibling `./scan.js`, so the plugin
directory needs **no `node_modules`**; the browser half requires only `react` (icons are inline SVG,
styles are injected through one `<style data-plugin-css>` tag).

## Security boundary

`/port-manager/api` is a raw `node:http` route registered by the plugin: it bypasses the dsh `/api`
gateway, so it carries neither the gateway's Host/Origin check nor its auth cookie. The host half
therefore re-implements the same loopback / `trustedHosts` / same-origin / `sec-fetch-site` fence and
returns 403 otherwise. `kill` re-verifies with `lsof -iTCP:<port> -sTCP:LISTEN` that the PID still
listens on that port (PIDs get reused), checks the uid with `ps`, and then enforces the protection
policy **server-side** (a greyed-out button is not a security boundary): system accounts, binaries
under `/System` or `/usr/libexec`, macOS ControlCenter (AirPlay holds 5000/7000), and the DSH host's
own process chain — the plugin lives inside the host process, so killing any of its ancestors would
take the UI down with it. That last rule is decided from the process tree, never from the request's
`Host` header.

## Development

```bash
node --test    # 32 cases: parsers, route, fence, bundle registration, real component rendering,
               #            and a real-cordis integration scenario over real HTTP
```

## License

MIT
