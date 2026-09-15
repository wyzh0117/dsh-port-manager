# DSH plugin recipe — host half with a JSON API + local shell commands

**Target:** DSH (DeepSeek Harness) `0.1.5-rc.2` at `/Users/youngi/.local/lib/node_modules/@deepseek-ai/dsh/`
**Profile:** `web` → `/Users/youngi/.dsh/profiles/web/`
**Plugin under construction:** `dsh-port-manager` at `/Users/youngi/Documents/MiniWork/dsh插件/dsh-PortManager`

Every claim below carries a `file:line` citation. Items I could **not** verify from source are
marked **⚠️ UNVERIFIED**. The code in §7 was additionally **extracted from this document and
executed** — 36/36 assertions pass, including real `lsof`/`netstat` output on this machine (§10).

---

## 0. TL;DR

- A host plugin is an **ordinary Cordis plugin** loaded as a profile loader row. Two accepted
  module shapes: `export default class X extends Service` (instantiated as `new X(ctx, config)`)
  or `export function apply(ctx, config)` + `export const name/inject/Config`.
- The host↔client channel used by every working third-party plugin here is a **plain fenced HTTP
  JSON route** registered on `ctx.webServer` — *not* Cordis RPC. `dsh-skill-select` is the
  canonical template.
- **The fence is optional but you must write it yourself**: a plugin prefix route is a raw
  `node:http` handler that bypasses DSH's `/api` gateway entirely (no browser token, no auth).
  Without the loopback + `sec-fetch-site` + `Origin` check, any web page the user visits can
  POST to your route (CSRF). For a *kill-process* API that is a real vulnerability.
- Shell commands: DSH exposes a sandboxed seam at **`ctx.shell`** (`ShellExecutor`), but every
  working plain-JS plugin here shells out with **`node:child_process`** directly. For a port
  manager the correct primitives are `execFile("lsof", …)` to list and the built-in
  **`process.kill(pid, signal)`** to kill — no subprocess at all for the kill path.
- Client half: a hand-written `window.__ModuleLoader__.load({id, factory})` file. **No build step
  is required.** The bundle path comes from `package.json` `exports["./client"]` — *not* from
  `dsh.client.main`.
- Install: `dsh plugin --profile web add link:/abs/path` → forwards to
  `pnpm add link:/abs/path` in the profile dir, then auto-reconciles `dsh.profile.bundles`.
  It does **not** touch `cordis.patch.yml`. The mount row lives in the *plugin's own*
  `cordis.patch.yml`, pulled in through `dsh.bundle.patch`.
- Restart: **yes**, a new *bundle layer* needs a `dsh web` restart. But the web profile's
  `patchReload` is `live`, so editing the *profile's own* `cordis.patch.yml` hot-applies.
- The §7 code is not pseudocode: it was run. `parseLsof` returned 23 real listening sockets and
  `parseNetstat` resolved all 27 pids against this machine's actual output; the fence, kill
  guardrails, route handler and client bundle all pass stubbed tests (§10).

---

## 1. Host half skeleton

### 1.1 What the module must export

The vendored Cordis loader normalizes the imported module before mounting it
(`@deepseek-ai/cordis-plugin-loader/lib/index.js:745-751`):

```js
/** Normalize ESM/CJS/default export shapes before applying a plugin. */
unwrapExports(exports) {
  if (isNullable(exports)) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}
```

`mod.default ?? mod` — so **both** of these are valid, and they are the two shapes in use locally:

**(a) Object/function plugin — named exports** (`dsh-notebook/lib/index.js`, last line):

```js
export { Config, apply, name };
```

`dsh-screenshot/lib/index.js:20-25`:

```js
export function apply(ctx) {
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.register(SCREENSHOT_NAMESPACE, ScreenshotSettingsSchema);
  });
}
```

`dsh-work-scope/lib/index.js:19` adds `export const name = "work-scope";`.

**(b) `Service` subclass as default export** (`dsh-skill-select/lib/index.js:699-717`):

```js
export default class SkillSelectService extends Service {
  static inject = ["skills", "sessions", "webServer", "storageDomain", "settings", "llm", "tools"];

  constructor(ctx) {
    super(ctx, "skillSelect");
  }

  async [Service.init]() {
    /* … */
  }
}
```

Instantiation for a class plugin is `new runtime.callback(this.ctx, this.config)` followed by the
`Service.init` hook (`@deepseek-ai/cordis/lib/index.js:1066-1070`):

```js
execute: function() {
  if (isConstructor(runtime.callback)) {
    const instance = new runtime.callback(this.ctx, this.config);
    for (const hook of instance?.[symbols.initHooks] ?? []) hook();
    return instance?.[symbols.init]?.();
  } else return runtime.callback(this.ctx, this.config);
},
```

Everything else Cordis accepts is described at `@deepseek-ai/cordis/lib/index.js:1526-1538`
(`resolve(plugin)`: a `function`, or an object with a `.apply` function) and the throw at
`@deepseek-ai/cordis/lib/index.js:1620`:

```js
if (!callback) throw new Error("invalid plugin, expect function or object with an \"apply\" method, received " + typeof plugin);
```

### 1.2 `inject` and `Config` conventions

- `inject` is read from the **plugin value**, not the module: `Inject.resolve(plugin.inject)` at
  `@deepseek-ai/cordis/lib/index.js:1631`. For a class that means `static inject = [...]`
  (skill-select:700); for an object plugin `export const inject = [...]`
  (`dsh-web-app/lib/index.js:32`: `const inject = ["webServer"];`, exported at line 220;
  `dsh-notebook` likewise). Names are **service names** (`"webServer"`, `"shell"`, `"settings"`),
  not package names.
- Use `static inject` only for hard dependencies; otherwise `ctx.get("name")` with an
  `undefined` check — this is stated explicitly in the shipped `cordis-plugin-development` skill
  (`@deepseek-ai/dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md`):
  *"Read optional capabilities with `ctx.get(name)` by default and handle their absence… Do not
  access `ctx.requiredService` without declaring the injection; the Guard rejects undeclared
  dependencies."* `dsh-notebook` follows the optional pattern for `webServer` and falls back to
  `ctx.inject(["webServer"], …)` when it is not up yet
  (`dsh-notebook/lib/index.js:1492-1500`).
- `Config` is optional. `@deepseek-ai/cordis/lib/index.js:955-957`:
  ```js
  function resolveConfig(runtime, config) {
    if (!runtime.Config) return config;
    const result = runtime.Config["~standard"].validate(config);
  ```
  `dsh-notebook/lib/index.js` uses `const Config = z.object({...})` with `.default()` on every
  field so the plugin loads with a bare `{ id, name }` row; `dsh-skill-select` and
  `dsh-screenshot/v2` declare none. `dsh-screenshot` guards explicitly against the removed
  `settingsNamespace()`: *"dsh 0.1.5+: settingsNamespace() was removed; pass the string ns
  directly."* (`dsh-screenshot/lib/index.js:22`).

### 1.3 How `cordis.patch.yml` mounts it

A loader row is `{ id, name, config?, inject?, disabled? }`. `id` is your row identity (used for
id-targeted overrides later in the stack); `name` is the **npm package name** (or a subpath /
`cordis:*` builtin). All four working plugins: `dsh-skill-select/cordis.patch.yml`,
`dsh-screenshot/cordis.patch.yml`, `dsh-work-scope/cordis.patch.yml`,
`dsh-notebook/cordis.patch.yml` are one-liners of the shape:

```yaml
- insert:
    - id: skill-select
      name: 'dsh-skill-select'
```

`dsh-skill-select/cordis.patch.yml` documents it verbatim:

```yaml
# dsh-skill-select bundle patch
#
# Mounts the host half as a profile loader row. The official CLI
# (`dsh plugin add dsh-skill-select`) reconciles `dsh.profile.bundles` from this
# declaration; manual installs add the same row to the profile's
# `cordis.patch.yml` by hand — see README.md.
- insert:
    - id: skill-select
      name: 'dsh-skill-select'
```

Patch layers are composed in this order (`lib/profile-boot-Dk-7KqJc.js:212-220`):

```js
function allPatches(composed) {
  return [
    ...composed.bundlePatches,      // bundle layers, in dsh.profile.bundles order
    ...composed.profile.patches,    // the profile's own cordis.patch.yml
    ...composed.homePatches,        // $DSH_HOME/cordis.patch.yml
    ...composed.overlays            // --patch
  ];
}
```

Later layers override earlier by `id` (`composeEntries`, cited at
`lib/profile-boot-Dk-7KqJc.js:242-248`).

### 1.4 Minimal working `lib/index.js`

The **zero-dependency** form (no imports at all → no `node_modules` needed in the plugin dir,
see §6.5). This is the recommended starting point:

```js
/**
 * dsh-port-manager — host half.
 *
 * Registers `ctx.portManager` and a fenced JSON API at /port-manager/api.
 * No imports on purpose: an object plugin with no module-level dependency needs
 * no node_modules/ in the plugin directory (see §6.5).
 */
export const name = "dsh-port-manager";
export const inject = ["webServer"];

export function apply(ctx) {
  // `ctx.provide` publishes the service under this fiber and ALREADY registers
  // its own disposer via `fiber.effect` — do not wrap it in ctx.effect too.
  // Signature: provide(name, value, check?) -> () => void
  // (cordis/lib/index.js:799-822; types at cordis/lib/types/reflect.d.ts:41-43)
  ctx.provide("portManager", { ping: () => "pong" });

  // Route registration DOES need ctx.effect: the disposer must run on reload,
  // or the second mount throws `webserver: duplicate prefix route`.
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/port-manager/api",
    handler: async (req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, value: { pong: true } }));
    },
  }), "port-manager: route");
}
```

Other rows then reach the service either as `ctx.get("portManager")` (optional, no declaration) or
as `ctx.portManager` after declaring `inject: ["portManager"]`.

The **`Service` subclass** form (what `dsh-skill-select` uses) requires one import:

```js
import { Service } from "@deepseek-ai/cordis";

export default class PortManagerService extends Service {
  static inject = ["webServer"];

  constructor(ctx) {
    super(ctx, "portManager");   // registers as ctx.portManager
  }

  async [Service.init]() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: "prefix",
      path: "/port-manager/api",
      handler: this.#handle,
    }), "port-manager: api route");
  }
}
```

Both are complete and loadable. §7 gives the full production version.

---

## 2. The JSON route

### 2.1 Registration API (exact)

`ctx.webServer` is `@deepseek-ai/dsh-host-webserver`'s `WebServer extends Service`
(`math:dsh-host-webserver/lib/index.js:139`, `super(ctx, "webServer")` at line 152). The route
contract (`dsh-host-webserver/lib/types/index.d.ts:30-38`):

```ts
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix';

export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
```

`register` returns a disposer and throws on a duplicate `(kind, path)`
(`dsh-host-webserver/lib/index.js:176-185`):

```js
register(route) {
  const table = route.kind === "exact" ? this.exact : this.prefixes;
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
  table.set(route.path, route);
  return () => { table.delete(route.path); };
}
```

Always wrap the registration in `ctx.effect(...)` so a reload disposes it instead of throwing
"duplicate route" — `dsh-notebook/lib/index.js` states this: *"Route registration is wrapped in
`ctx.effect` so HMR / plugin reload disposes the previous registration instead of throwing
'already registered'."*

### 2.2 The fence — required or optional?

**Optional at the framework level. Mandatory in practice for anything destructive.**

A plugin's `webServer.register` route is a raw `node:http` handler on the same port as the DSH
GUI. It is **not** behind DSH's `/api` gateway. The gateway's own gate is
`HostConnectionService.requestRejection`
(`dsh-client-connection/lib/index.js:553-556`):

```js
requestRejection(request) {
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
  return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
}
```

i.e. DSH's own routes get **both** the Host/Origin fence **and** the browser-auth cookie
(`BrowserAuth.authorizeIndex`, `dsh-client-connection/lib/index.js:386-404`, mints a cookie from
the `?token=` launch URL). Your plugin route gets **neither** automatically. `dsh-skill-select`
therefore hand-rolls the fence and calls it out in its own header comment
(`dsh-skill-select/lib/index.js:444`):

```js
/** 浏览器信任围栏：与 /api 网关及 dsh-pin 相同的 loopback/trusted-host 检查。 */
export function isTrustedRequest(req, trustedHosts) {
  const host = req.headers.host;
  if (host === undefined) return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  const isLoopback = (hostname) => {
    if (hostname === "localhost" || hostname === "[::1]") return true;
    const parts = hostname.split(".");
    return parts.length === 4
      && parts[0] === "127"
      && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  };
  const trusted = (trustedHosts ?? []).some((entry) => { /* host[:port] compare */ });
  if (!isLoopback(hostUrl.hostname) && !trusted) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
```

`trustedHosts` comes from the `webRuntime` service, which `dsh-web-app` provides
(`dsh-web-app/lib/index.js:30` `const WEB_RUNTIME_SERVICE = "webRuntime";`, line 173
`ctx.provide(WEB_RUNTIME_SERVICE, runtime);`; shape from `resolveLanTrust` at lines 83-89:
`{ lanAddresses, trustedHosts }`). Read it **optionally**:

```js
const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];   // `this.ctx.get(...)` inside a Service method
```

Why it matters concretely: `fetch(url, {method:"POST", headers:{"content-type":"application/json"}})`
is not a CORS-simple request, so a cross-site attacker would need a preflight — **but** a
`Content-Type: text/plain` POST *is* simple, and the handler in §2.3 parses the body as JSON
regardless of content type. So an un-fenced route really is reachable from any page the user has
open. The `sec-fetch-site: cross-site` check (`dsh-skill-select/lib/index.js:473`) is what blocks
it. For a `/kill` endpoint, keep the fence.

### 2.3 Body parsing, JSON replies, error surfacing

`dsh-skill-select/lib/index.js:483-520` is the pattern to copy (bounded read → parse → envelope):

```js
const MAX_BODY_BYTES = 1 << 20;

export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new SkillSelectApiError("bad-request", "request body too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try { return JSON.parse(text); }
  catch { throw new SkillSelectApiError("bad-request", "request body is not valid JSON"); }
}

export function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function writeOk(res, value) { writeJson(res, 200, { ok: true, value }); }

export function writeError(res, error) {
  if (error instanceof SkillSelectApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  writeJson(res, 500, { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
}
```

with the error class at `dsh-skill-select/lib/index.js:436-442`:

```js
export class SkillSelectApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
```

**Path → method dispatch** (`dsh-skill-select/lib/index.js:1075-1082`) — a `prefix` route on
`/skill-select/api` turns the trailing segment into a method name and rejects nested paths:

```js
const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
const method = pathname.startsWith("/skill-select/api/")
  ? pathname.slice("/skill-select/api/".length)
  : undefined;
if (method === undefined || method.includes("/")) {
  writeError(res, new SkillSelectApiError("not-found", "unknown skill-select API method", 404));
  return;
}
```

`dsh-notebook` uses the alternative **verb + REST path** style with the same helpers
(`sendJson` / `sendError` at `dsh-notebook/lib/index.js:946-961`; dispatch at lines 1335-1371:
`GET /notebook/api/state`, `POST /notebook/api/notes`, `PATCH /notebook/api/notes/:id`,
`DELETE /notebook/api/notes/:id`). Its error envelope is `{ error: { code, message } }` and its
catch-all maps `HttpError` → its `status`, anything else → `500 INTERNAL_ERROR`
(`dsh-notebook/lib/index.js:1385-1392`).

### 2.4 How the client half calls it

`dsh-skill-select/lib/client.js:149-165` — no token, no custom headers beyond JSON, no
`credentials` option (same-origin `fetch` already sends cookies by default):

```js
async function apiCall(method, payload) {
  let response;
  try {
    response = await fetch(`/skill-select/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  } catch (error) {
    throw new Error(`network: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = await response.json().catch(() => null);
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
  }
  return parsed.value;
}
```

- **URL:** relative, same origin as the GUI. The GUI is served from
  `http://127.0.0.1:3080` (`dsh-web-app/cordis.patch.yml`, `webserver` row: `port: … ?? 3080`) —
  never hardcode it; a relative path survives port/`--trusted-host` changes.
- **Method:** `POST` only; the host handler answers `405 method-error` for anything else
  (`dsh-skill-select/lib/index.js:1071-1074`).
- **Auth/CSRF:** no header, no token, no `credentials` option. The plugin route is outside `/api`,
  so the `?token=`→cookie exchange does not apply. Full picture:
  - `dsh web` prints a URL carrying `?token=<processLaunchToken>`; `authorizeIndex` exchanges it for
    a signed, authority-bound cookie and 303-redirects to clean `/`
    (`dsh-client-connection/lib/index.js:378-425`). The cookie is
    `HttpOnly; SameSite=Strict; Path=/` (`:292-294`), value `v1.<b64url(json)>.<b64url(HMAC)>`,
    30-day default (`:740`).
  - Only routes registered **through connection** see it: `requestRejection` runs
    `isTrustedApiRequest(...)` → 403, then `browserAuth.isAuthenticated(...)` → 401
    (`:552-556`). That cookie is `SameSite=Strict` and same-origin `fetch` defaults to
    `credentials: "same-origin"`, so it rides along automatically — **`credentials: "include"` is
    unnecessary** (it targets cross-origin) and `dsh-skill-select` passes none.
  - **There is no CSRF token and no `Authorization` header anywhere in this stack.**
    `@deepseek-ai/dsh-authorization` is unrelated — it is a credential-obtaining *flow registry*
    for model credentials (`ctx.authorization.registerFlow`,
    `dsh-authorization/lib/index.js:54-90`), not HTTP request auth.
  - `dsh-host-webserver` itself does **no** checking at all — it matches and calls the handler
    (`dsh-host-webserver/lib/index.js:230-241`). Your fence (§2.2) is the only gate, and the
    browser-session cookie gives you nothing because your route never inspects it.

### 2.5 The other transport: Typert Remote

`dsh-work-scope` does **not** use HTTP at all. It subclasses `TypertRemoteService`, registers a
service, and ships two descriptor files:

```js
// dsh-work-scope/lib/index.js:16
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// dsh-work-scope/lib/index.js:326-330
class WorkScopeGateway extends TypertRemoteService {
  constructor(ctx, config = {}) {
    super(ctx, "workScope");
```

```js
// dsh-work-scope/lib/index.js:394-396
export function apply(ctx, config = {}) {
  const store = { items: [], path: "", selection: new Set(), scenario: DEFAULT_SCENARIO };
  // 直接实例化网关（其构造函数会通过 super(ctx, "workScope") 注册为服务）。
  new WorkScopeGateway(ctx, { ...config, store });
```

- **Host face** — `lib/typert.host.js` exports `TYPERT = { package, face: "host", schemas,
  invocations: [{ id: "dsh-work-scope#workScope/list", service, namespace, method,
  invocation: { kind: "direct" }, parameters: [{name, wire, source:"json", codec:{mode:"strict",
  typeSymbol, schema}}], result: { mode:"strict", typeSymbol, schema }, sourceLocation }],
  model: {...} }` (`dsh-work-scope/lib/typert.host.js:36-155`). Its header says the
  `typert-loader` imports and registers it into `ctx.typert.local` at mount time so the
  api-gateway can dispatch strict client RPC.
- **Client face** — `lib/typert.remote-client.js` exports `TYPERT_REMOTE = { package,
  descriptors: [ …same descriptors… ] }` (line 32-144). Its header notes the *browser* half
  actually runs `lib/client.js`, which inlines an equivalent lightweight `TYPERT_REMOTE` because
  *"客户端 bundle 需自包含、无法依赖 Node 侧 zod 包"* (the client bundle must be self-contained
  and cannot depend on the Node-side zod package); `/remote` is kept for a full tsdown/typert
  toolchain.
- Package wiring: `exports["./typert"]` and `exports["./remote"]` (`dsh-work-scope/package.json`),
  `dsh.client.inject: ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-session-controller"]`.

**Which to use?** Typert is the framework's typed RPC with schema validation, but it costs two
extra descriptor files, a zod dependency, and a codegen-shaped contract. Its transport is split:

- **Unary calls go over HTTP POST `/api/<namespace>/<method>`**, via `ctx.connection.rpc.call`
  (`dsh-api-gateway/lib/client.js:1627-1628`):
  ```js
  const result = await connection.rpc.call("/api", endpoint, { args: prepared.args }, prepared.signal);
  ```
- **Streams use one shared WebSocket** at `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"`
  (`dsh-api-gateway/lib/client.js:48-49`, `:402`, `:541-547`), i.e. `ws(s)://<origin>/api/remote.mux`.
- **Strict codecs are mandatory** — the client only ever calls `codec.schema.parse(value)` and
  throws `client api: generated Remote <endpoint> field "<name>" has no strict codec` otherwise
  (`dsh-api-gateway/lib/client.js:1823-1838`).
- `dsh-api-remotes`' browser half is *just* an assembly that awaits `ctx.remote.$mount(contribution)`
  for a list of **generated** descriptors, with `const inject = ["remote"]`
  (`dsh-api-remotes/lib/client.js:9633-9671`). Its node half registers forwarded Host events
  (`dsh-api-remotes/lib/index.js:96-131`, `inject = ["typertGateway"]`). It is not a generic
  "call any host service" facility.

For a plugin that just needs "list ports / kill pid", the fenced-JSON route is far less machinery
and is what `dsh-skill-select`, `dsh-notebook`, `dsh-screenshot` and the DSH dynamic-plugin guide
(`harness.handle` / `host.call`, same JSON-RPC idea) all reduce to. Use `$mount` + descriptors only
when you need typed codecs, rpcId correlation, cancellation, reconnect semantics or streaming —
and only when both `dsh-api-gateway` and `dsh-api-remotes` are in the composition.

---

## 3. Running shell commands from the host half

### 3.1 Does DSH expose `ctx.bash` / `ctx.terminal` / `ctx.shell`?

There is **no `ctx.bash` and no `ctx.terminal`**. The seam is **`ctx.shell`**
(`@deepseek-ai/dsh-shell`), an abstract service declared on the Cordis context
(`dsh-shell/lib/types/index.d.ts`):

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        shell: ShellExecutor;
    }
}
```

```ts
export declare abstract class ShellExecutor extends Service {
    constructor(ctx: Context);
    get sandboxMode(): SandboxMode | undefined;
    abstract resolve(request: ShellExecRequest): ShellExecSpec;
    abstract run(spec: ShellExecSpec): Promise<ShellRunResult>;
    abstract start(spec: ShellExecSpec): ShellProcess;
}
```
(`dsh-shell/lib/types/index.d.ts:62,69,75`)

`super(ctx, "shell")` is at `dsh-shell/lib/index.js:86`. The providers are host-plane rows in
`dsh-base` (`@deepseek-ai/dsh-base/cordis.patch.yml:214`):

```yaml
    - id: bash-sandbox
      name: '@deepseek-ai/dsh-bash-sandbox'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 60000
```

with `SandboxBashExecutor extends LocalBashExecutor` injecting `["subprocess", "sandbox",
"sandboxPolicy"]` (`dsh-bash-sandbox/lib/index.js:111-118`) and `LocalBashExecutor extends
ShellExecutor` injecting `["subprocess"]` (`dsh-bash-local/lib/index.js:127,340`).

**So `ctx.shell` IS available in the `web` profile host plane** — `dsh-web-app/cordis.patch.yml`
disables only the *model-facing* tool row (`- id: tool-bash / disabled: true`), not
`bash-sandbox`.

`ctx.subprocess` is the lower-level primitive (`dsh-subprocess/lib/index.js:88`
`super(ctx, "subprocess")`), consumed by both executors.

### 3.2 What plugins actually do

Every working third-party plugin here uses `node:child_process` directly:

- `dsh-skill-select/lib/index.js:29-30`
  ```js
  import { execFile } from "node:child_process";
  import { promisify } from "node:util";
  ```
  used at lines 371, 388-397, 413-415 (`git rev-parse`, `git pull --ff-only`, `git clone`,
  `cp -R`), each with `{ timeout, maxBuffer }`.
- `dsh-better-sidebar/lib/index.js:980` `spawn(spec.command, spec.args, {…})`, `:1089`
  `spawn("git", full, {…})`, plus `node-pty` for real terminals (`:1692`, `:2197`).

No third-party plugin in `/Users/youngi/.dsh/profiles/web/node_modules` consumes `ctx.shell`
except through the built-in bash tool.

### 3.3 The sanctioned pattern, and why it matters for killing a process

There are two legitimate patterns; pick by *whose operation it is*:

| | `ctx.shell` | `node:child_process` |
|---|---|---|
| Enforced by | `bash-sandbox` → `ctx.sandbox` / `ctx.sandboxPolicy` (`dsh-bash-sandbox/lib/index.js:111-118`) | nothing |
| Policy | `DSH_PERMISSION_MODE` / deployment mode (`dsh-base/cordis.patch.yml`: `sandbox-policy` row, `mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`) | none |
| Approval | model-facing tool layer asks `ctx.get("approval")` (`dsh-tool-bash/lib/index.js:247`); a direct `ctx.shell` call from a plugin bypasses that | none |
| Timeout/output caps | `resolve()` clamps to `timeoutMs`/`maxOutputBytes` (`dsh-bash-local/lib/index.js:120-131`) | you pass them yourself |
| Intended consumer | the model's `bash` tool (`dsh-tool-bash/lib/index.js:111-116` injects `["tools","shell","systemPrompt","shellEnv"]`) | plugin-owned admin operations |

Practical guidance for a **port manager**:

- **List ports:** `execFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])` — read-only, no privilege
  needed, and `execFile` (not `exec`) means no shell is spawned, so no injection surface. Pin the
  absolute path (`/usr/sbin/lsof`) or accept `ENOENT` and fall back to
  `execFile("netstat", ["-anv", "-p", "TCP"])`.
- **Kill a process:** use Node's built-in **`process.kill(pid, "SIGTERM")`**. No subprocess, no
  shell, no sandbox question, and it throws a normal `Error` with `code` `ESRCH` (no such
  process) / `EPERM` (not yours) that you map straight to your JSON error envelope.

**Sandbox/permission implications.** The DSH file sandbox (`dsh-fs-sandbox`, `dsh-sandbox-local`)
governs file effects and sandboxed *spawned commands*, not the plugin host process itself. Plugin
host code runs in-process as the user who started `dsh web` and therefore has that user's full
privileges. Two consequences worth stating in your README:

1. Anything the plugin can do, it can do **without an approval prompt**. A `kill` endpoint is a
   genuine privilege grant; treat the fence (§2.2) as load-bearing, and validate `pid` as a
   positive integer before passing it to `process.kill`.
2. Your own subprocesses are **not** killed automatically when the plugin unloads. Register an
   `ctx.effect` disposer if you `spawn` anything long-lived. (Contrast: `ctx.shell.start()`'s
   contract is *"A still-running background process is stopped and awaited when its owning
   composition tears down"* — `dsh-shell/lib/types/index.d.ts:47-49` — which is a real advantage
   of the seam if you need a long-running child.)

**⚠️ UNVERIFIED:** whether macOS Seatbelt (`dsh-fs-sandbox`) would allow `lsof` to enumerate all
listening sockets when invoked through `ctx.shell`. I did not execute a sandboxed `lsof` to
confirm; this is one more reason to use `execFile` directly for this particular read.

---

## 4. Client bundle loading

### 4.1 How DSH finds the browser half

`@deepseek-ai/dsh-client-modules` (dual-face; node half composes the boot graph). The scan:

```js
// dsh-client-modules/lib/index.js:649-656
const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
if (decl === void 0 || decl.platform !== "web") {
  this.pkgMeta.set(sourceKey, null);
  return null;
}
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```

Three facts fall out of this, and they contradict a common assumption:

1. **The bundle path comes from `package.json` `exports["./client"]`, NOT from
   `dsh.client.main`.** I grepped for every reader of `client.main` /
   `dsh.client.main` across all 240 `@deepseek-ai/*` packages: **zero hits**. The four working
   plugins' `package.json` `dsh.client` blocks contain only `inject` and `platform` — no `main`
   (e.g. `dsh-skill-select/package.json`: `"client": { "inject": ["@deepseek-ai/dsh-client-ui-conversation"], "platform": "web" }`).
   `dsh.plugin.json`'s `client.main` is documentation only (§6.2).
2. **`dsh.client.platform` must be exactly `"web"`** or the package is silently skipped
   (`decl.platform !== "web"` → `null`).
3. Declaring `dsh.client` without an `exports["./client"]` entry is a **hard throw** at registry
   construction time — it fails the whole web boot, not just your plugin.

The declaration validator, `dsh-client-modules/lib/index.js:139-152`:

```js
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
```

and the export reader, `dsh-client-modules/lib/index.js:156-166`:

```js
function clientExportOf(pkgName, exportsField) {
	if (typeof exportsField !== "object" || exportsField === null) return void 0;
	const client = exportsField["./client"];
	if (client === void 0) return void 0;
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null) {
		const fallback = client.default;
		if (typeof fallback === "string") return fallback;
	}
	throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}
```

**A missing `./client` export is a boot-fatal error, not a warning.** The throw escapes
`resolveMeta` inside `processOne`'s `try/catch` (`index.js:793-797`), is collected by the
constructor (`index.js:477-479`), and is rethrown as `ClientPackageCompositionError`
(`index.js:106-120`) whose rendered message is:

```
client-modules: 1 client package failed to compose:
  other failures:
    - client-modules: <pkg> declares dsh.client but exports no "./client" bundle
```

A distinct case — the export exists but the file is absent on disk — raises
`MissingClientBundleError` (`index.js:93-105`, thrown from `initialBundleSnapshot` at
`index.js:750-764`):

```
client-modules: client bundle not found; run `pnpm run build` before launch:
  package: <pkg>
  path: <abs path>
```

where `CLIENT_BUNDLE_BUILD_INSTRUCTION` is `` "run `pnpm run build` before launch" ``
(`index.js:91`). That instruction is aimed at **TypeScript-authored** packages; a hand-written
bundle merely has to exist on disk.

### 4.2 The wire format and URL

`graphRow` (`dsh-client-modules/lib/index.js:326-337`) and `comboUrl` (line 182-184):

```js
/** Address one ordered plugin-file list through the shared combo route. */
function comboUrl(ids, rev, sourceMap = false) {
  return `/plugins/??${ids.map((id) => `${id}/client.js${sourceMap ? ".map" : ""}`).join(",")}&rev=${rev}`;
}
```

```js
function graphRow(id, rev, fields) {
  return {
    id,
    url: comboUrl([id], rev),
    rev,
    ...fields.inject !== void 0 ? { inject: fields.inject } : {},
    ...fields.immediately ? { immediately: true } : {},
    ...fields.external.length > 0 ? { external: fields.external } : {}
  };
}
```

The wire type is the single source (`dsh-client-modules/lib/types/client/manifest.d.ts:38-59`):

```ts
export interface WebBootEntry {
    /** Entry name == package name. */
    id: string;
    /** Revisioned single-resource combo endpoint used by HMR. */
    url: string;
    /** Opaque plugin-artifact revision used for HMR cache busting. */
    rev: string;
    /** Package-name dependency edges used for factory arrival and plugin composition. */
    inject?: string[];
    /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
    immediately?: boolean;
    /** Non-baseline module specifiers this row requests; omitted when it requests none. */
    external?: string[];
}
```

`WebBootGraph` is `{ rev, entries, batches }`, and `WebBootBatch` is
`{ phase: 'bootstrap' | 'application', url, rev, entries }` (`manifest.d.ts:73-85`). The
**bootstrap** batch is exactly `@deepseek-ai/dsh-client-modules` itself
(`const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID]`, `index.js:373-375`); every other row is
`application`, in `orderByModuleGraph` order (`compose()`, `index.js:586-629`).

Served by a `prefix` route on `/plugins` (`dsh-client-modules/lib/index.js:480-488`):

```js
const registerWebCarrier = (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register({
    kind: "prefix",
    path: "/plugins",
    handler: this.serveBundle
  }), "client-modules: bundle route");
};
if (ctx.get("webServer") === void 0) ctx.inject(["webServer"], registerWebCarrier);
else registerWebCarrier(ctx);
ctx.on("webserver/index-inject", (table) => {
  table.push(...bootInjections(this.composed));
});
```

Serving rules (`index.js:857-871`, `:208-221`, `:278-314`): only `GET`/`HEAD` (else **405**);
`content-type: text/javascript; charset=utf-8` for scripts, `application/json` for `.map`;
`cache-control: public, max-age=31536000, immutable`; unknown URL or stale `rev` → **404**. The
body is the file's bytes with the `//# sourceMappingURL=` trailer stripped, a trailing newline
ensured, and `;\n` appended.

The graph reaches the page as an inline global plus preloads, via the index tap
(`bootInjections`, `index.js:387-432`), rendered by the web server's `renderRow`
(`dsh-host-webserver/lib/index.js:24-52`) as
`<script>globalThis["__DSH_BOOT__"] = {…}</script>` with every `<` in the JSON escaped to
`\u003c` so plugin-controlled strings cannot break out of the script element.

**HMR uses a separate endpoint**: `const EVENTS_ENDPOINT = "/plugins/events"`
(`dsh-client-hmr/lib/index.js:5`), registered as `{kind:"exact", path:EVENTS_ENDPOINT}`
(`dsh-client-hmr/lib/index.js:134-148`).

### 4.3 What the bundle file must contain

Plain-JS plugins hand-write the loader call. `dsh-skill-select/lib/client.js:19-24` header:

```js
window.__ModuleLoader__.load({
  id: "dsh-skill-select",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    let ReactDOM = require("react-dom");
```

and its footer (`dsh-skill-select/lib/client.js:1184-1205`):

```js
    exports.apply = apply;
    exports.inject = inject;
    // 测试钩子（浏览器中惰性无害）。
    exports.__test = { /* … */ };
    return module.exports;
  },
});
```

`dsh-screenshot/lib/client.js:10-17` is the same shape:

```js
window.__ModuleLoader__.load({
  id: "dsh-screenshot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
```

Rules that follow, all verified in the browser loader (`dsh-client-modules/lib/client.js`):

- The file is loaded as a **classic script** (`<script async src=…>`, no `import`/`export`
  syntax) purely for its side effect (`client.js:145-159`). It must **register** a factory:
  `arrive()` throws `client-modules: bundle ${url} loaded without registering "${id}" via
  __ModuleLoader__.load` otherwise (`client.js:228-251`).
- `id` **must be the package name** — or `<pkg>/client`, which `stripClientSuffix` normalizes to
  the same id (`client.js:61-63`). Executing the same bundle twice without invalidation throws
  `client-modules: duplicate factory registration for "…" (bundle executed twice without
  invalidate?)` (`client.js:228-232`).
- **The factory's return value IS the module's exports** (`client.js:271-293`):
  ```js
  const record = { id, exports: registered(this.makeRequire(edges)), styles: claimStyles(id), edges };
  ```
  hence the `var module = { exports: {} }; … return module.exports;` idiom.
- Export `apply` and `inject` on `exports` — the browser-side Loader applies them exactly like a
  Cordis plugin (`isApplicable` / `Inject.resolve(plugin.inject)` /
  `"invalid plugin, expect function or object with an \"apply\" method"`,
  `@deepseek-ai/cordis/lib/index.js:1445-1447`, `:1535`, `:1620`). `exports.inject` holds
  **Cordis service names** (`dsh-screenshot/lib/client.js:807`:
  `const inject = ["slots", "connection", "remote", "settingsScope", "sessions"];`), which is
  *not* the same list as package.json's `dsh.client.inject` (package names).
- **Only 9 specifiers are `require`-able without any declaration** — the shell's static seed
  table:
  ```js
  {react, "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis",
   "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
   "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit"}
  ```
  Resolution order in `makeRequire` is seed → memoized → registered factory → throw
  (`client.js:301-310`). This is why `require("react")` / `require("react-dom")` "just work" in a
  hand-written bundle, and why anything else needs a graph row that already arrived.
- **Your client bundle must be fully self-contained.** `dsh-screenshot/lib/client.js:8` says it
  plainly: *"Pure helpers are inlined from lib/logic.js (this bundle cannot import local ESM)."*
  `dsh-work-scope/lib/typert.remote-client.js:4-5` repeats it. You cannot `import`/`require` your
  own sibling files — inline them.
- Reach services through `ctx`, **not** `require`: `ctx.slots`, `ctx.locale`, `ctx.remote`,
  `ctx.connection`, `ctx.settings`, after `exports.inject = [...]`. `dsh-skill-select/lib/client.js:123`
  warns that `require()`ing a package that is not in the module table
  (*"`@deepseek-ai/dsh-client-runtime` 不再是模块表种子包"*) *"会以 'missed the module table'
  炸掉整个 client bundle"* — it kills the whole bundle, not just your plugin.

### 4.4 Is a build step mandatory?

**No.** `dsh-screenshot`, `dsh-skill-select`, `dsh-work-scope` (and `dsh-better-sidebar` in the
profile's node_modules) ship hand-written plain-JS bundles with no build. `dsh-notebook` *does*
have `"build": "tsc -p tsconfig.build.json && tsdown"` and devDependencies on `tsdown`/`typescript`
— that is a **choice** for TypeScript authors, not a platform requirement. The shipped
`cordis-plugin-development` skill confirms the same for dynamic plugins: *"Both `code.host` and
`code.client` are plain JavaScript function bodies… They are not compiled by TypeScript, JSX, or a
bundler."*

### 4.5 `dsh.client.inject` vs `external` vs `immediately`

All three are validated in `parseDshClient` (`dsh-client-modules/lib/index.js:139-152`):

```js
if (typeof decl.platform !== "string") throw new Error(`client-modules: ${packageName} dsh.client.platform must be a string`);
const inject = optionalStringArray(packageName, "dsh.client.inject", decl.inject);
const external = optionalStringArray(packageName, "dsh.client.external", decl.external);
if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${packageName} dsh.client.immediately must be a boolean`);
```

**`external` is the only field that creates module-graph edges.** `orderByModuleGraph`
(`index.js:349-371`) sorts rows so every named package precedes its consumers, and the only two
composition-time errors in the whole graph are about `external`:

```js
for (const name of entry.external ?? []) {
  const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name));
  if (dependency === entry) throw new Error(`client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`);
  if (dependency !== void 0) visit(dependency);
}
```

(cycle error at line 358; self-request at 362). A missing supplier is **silently skipped** in both
loops — `if (dependency !== void 0) visit(dependency);`.

**`inject` is a best-effort arrival loop in the browser**, consumed by `arriveGraphRow`
(`dsh-client-modules/lib/client.js:252-270`):

```js
/** Register each injected package and unresolved dynamic request before its consumer. */
async arriveGraphRow(row, open = [], visited = /* @__PURE__ */ new Set()) {
  const cycleStart = open.indexOf(row.id);
  if (cycleStart !== -1) throw new Error(`client-modules: module arrival cycle ${[...open.slice(cycleStart), row.id].join(" -> ")} (the host must reject this graph before serving it)`);
  if (visited.has(row.id)) return;
  visited.add(row.id);
  const next = [...open, row.id];
  for (const request of row.external) {
    const id = stripClientSuffix(request);
    if (this.seed.has(request) || this.loadCache.has(id)) continue;
    const dependency = this.graphRows.get(id);
    if (dependency !== void 0) await this.arriveGraphRow(dependency, next, visited);
  }
  for (const packageName of row.inject) {
    const dependency = this.graphRows.get(packageName);
    if (dependency !== void 0) await this.arriveGraphRow(dependency, [], visited);
  }
  await this.arrive(row);
}
```

So naming `@deepseek-ai/dsh-client-ui-conversation` in `dsh.client.inject` does guarantee that
package's factory is registered before yours materializes — **but there is no
missing/unsatisfiable-inject detection.** If the named package is not a graph row,
`graphRows.get(...)` is `undefined`, the entry is skipped, and you get **silence**, not an error.
Note also that unlike `external`, `inject` is **not** passed through `stripClientSuffix`, so
entries must be exact bare package names.

**`immediately`** just marks stage-one prefetch: the shell fetches and registers the factory before
booting the plugin tree, in parallel, and **swallows failures**
(`prefetchImmediateTier` → `Promise.all(… .catch(r=>{}))`). `prefetch` itself throws
`client-modules: prefetch("<id>") — not a graph entry` for a non-row (`client.js:325`), which that
`.catch` eats. Shipped users: `dsh-client-modules`, `dsh-client-connection`, `dsh-client-hmr`,
`dsh-api-gateway`, `dsh-api-remotes`, `dsh-client-locale`. `dsh.client.inject` only guarantees the
**module arrived**; it does **not** create a Cordis service — for `ctx.slots` / `ctx.locale` /
`ctx.remote` you still need `exports.inject = ["slots", …]` in the bundle.

⚠️ **Note on `plugins[].inject`:** the wire's `WebBootEntry.inject` is also surfaced to the shell as
`plugins[].inject` (`manifest.d.ts:41-43` claims *"Cordis separately uses the same package edges to
compose entries"*), but in the shipped 0.1.5-rc.2 shell the only `manifest.plugins` consumers are
`filter(t => t.immediately)` and `map(a => a.id)` — the kernel calls `loaderApi.create({name: id})`
with no inject, and each entry's Cordis `inject` comes from the bundle's own `exports.inject`.
**Flagged as a doc/code mismatch; do not rely on `dsh.client.inject` to wire Cordis services.**

`dsh-notebook/package.json` lists `"inject": ["@deepseek-ai/dsh-client-locale",
"@deepseek-ai/dsh-client-ui-slots"]` — but `@deepseek-ai/dsh-client-ui-slots` is **not a Loader
row** in the web composition; the profile copy is v0.1.0-rc.7 with no `dsh` field and no
`./client` export, so it is only a shell seed. Listing it is harmless but inert. Prefer listing
real Loader rows.

**Practical effect for `dsh-port-manager`:** keep `dsh.client.inject: []` and
`exports.inject = []` while the client half only talks to its own host route. The moment you
register into a real Slot, add the owning package to `dsh.client.inject` **and** its service name
to `exports.inject` — e.g. for a `dsh-better-sidebar` tab, mirror
`dsh-skill-select/lib/client.js:1136` (`const inject = ["conversation"];`) and its
`registerTab`/`ctx.get("betterSidebar")` gating (lines 1103-1131, with a 3200 ms standalone
fallback at line 1171).

---

## 5. Installation / activation into the `web` profile

### 5.1 What the CLI actually is

`dsh plugin` is a **thin pnpm forwarder** — `lib/plugin-Ddi42qoW.js:8-16`:

```js
/**
* `dsh plugin --profile <name> <args...>` — profile plugin management as a
* thin pnpm forwarder: initialize the profile on first use, run
* `pnpm <args...>` in the profile directory, then reconcile the
* `dsh.profile.bundles` layer list against the installed state (a dependency
* resolving to a package that declares `dsh.bundle` joins the layer stack; a
* removed or bundle-less dependency leaves it).
```

Registration (`lib/bin.js:105-114`):

```js
const plugin = program.command("plugin").description("manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory");
plugin.requiredOption("--profile <name>", "the profile whose plugins to manage (initialized on first use)").allowUnknownOption().argument("[args...]", "pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)")
```

There is **no `list` subcommand** — only whatever pnpm accepts. Help text
(`lib/bin.js:41`): `dsh plugin --profile tui add <package>`.

Execution (`lib/plugin-Ddi42qoW.js:105-118`):

```js
const before = readProfileManifest(NAME, dir);
const result = spawnSync("pnpm", args.map((argument) => anchorPathSpec(argument, process.cwd())), {
  cwd: dir,
  stdio: "inherit",
  shell: process.platform === "win32"
});
```

and `anchorPathSpec` (lines 88-95):

```js
function anchorPathSpec(argument, cwd) {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument);
  if (match?.groups?.path === void 0) return argument;
  return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`;
}
```

**Consequences:** absolute paths pass through untouched; a bare `.`/`..` (with or without
`file:`/`link:`) is anchored to *your* cwd, so `dsh plugin --profile web add .` run from inside
the plugin directory does the right thing. If pnpm is missing you get
`dsh: pnpm not found on PATH` + exit 127 (lines 110-113).

### 5.2 What `add` writes — and what it does *not*

`reconcilePlugins` (`lib/plugin-Ddi42qoW.js:45-79`) reads the profile manifest *after* pnpm ran
and rewrites **only** `dsh.profile.bundles`:

```js
const after = readProfileManifest(NAME, profileDir);
const dependencies = Object.keys(after.dependencies ?? {});
const plugins = after.dsh?.profile?.bundles ?? [];
for (const packageName of dependencies) {
  const isBundle = exportsPatch(packageName, profileDir);
  if (isBundle && !plugins.includes(packageName)) { plugins.push(packageName); changed = true; }
  else if (!isBundle && !beforeDeps.has(packageName)) process.stderr.write(`${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer …`);
}
```

with `exportsPatch` (lines 20-32):

```js
return readProfileManifest(NAME, dir).dsh?.bundle?.patch !== void 0;
```

So:

- **`dsh plugin --profile web add <spec>`** → runs `pnpm add <spec>` with cwd
  `/Users/youngi/.dsh/profiles/web`, then appends the package's true name to
  `dsh.profile.bundles` **iff its `package.json` declares `dsh.bundle.patch`**. Otherwise you get
  the `declares no dsh.bundle` warning and it is installed as an inert dependency.
- It **never touches `cordis.patch.yml`** and never writes `dsh.plugin.json`. Grepping the whole
  CLI (`lib/bin.js`, `lib/plugin-Ddi42qoW.js`, `lib/profile-boot-*.js`, `lib/dump-config-*.js`)
  for `cordis.patch.yml` and `plugin.json`: the only hits are the profile patch *path* used by
  boot, and zero for `plugin.json`.
- Reconciliation is **by installed state, not by dependency diff**, so a later `dsh plugin
  --profile web update <pkg>` activates a package that only just gained `dsh.bundle`.

### 5.3 Where the mount row must live — bundles vs `cordis.patch.yml`

They are two different things and **you need the first**:

- `dsh.profile.bundles` (in the profile `package.json`) = the ordered list of **patch layers**.
  `composeProfile` expands it: `const bundlePatches = profile.layers.flatMap((layer) => layer.patches);`
  (`lib/profile-boot-Dk-7KqJc.js:240`).
- Each layer's `patches` come from that package's `dsh.bundle.patch` file — i.e. **the plugin's
  own `cordis.patch.yml`**. That file is where the `insert` row lives.

⇒ Adding the package name to `dsh.profile.bundles` **alone does nothing**; the bundle's patch file
must contain the `insert`. Equivalently, and as a pure alternative, you may put the same `insert`
row in the **profile's** `cordis.patch.yml` by hand — the `cordis.patch.yml` header comment in
`dsh-skill-select` says exactly this ("manual installs add the same row to the profile's
`cordis.patch.yml` by hand"). The four installed plugins use the **bundle route**, and the profile's
`cordis.patch.yml` currently contains only the CloudBase MCP row.

Current state to reproduce (`/Users/youngi/.dsh/profiles/web/package.json`):

```json
  "dependencies": {
    "dsh-notebook": "link:/Users/youngi/Documents/MiniWork/dsh插件/dsh-notebook",
    "dsh-screenshot": "link:/Users/youngi/Documents/MiniWork/dsh插件/dsh-screenshot",
    "dsh-skill-select": "link:/Users/youngi/Documents/MiniWork/dsh插件/skill-select",
    "dsh-work-scope": "link:/Users/youngi/Documents/MiniWork/dsh插件/dsh-work-scope",
    …
  },
  "dsh": { "profile": { "bundles": [
      "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
      "dsh-better-sidebar", "api-balance", "dsh-skill-select", "dshmarket",
      "dsh-screenshot", "dsh-work-scope", "dsh-notebook" ] } }
```

Note the names are **package names** (`dsh-skill-select`), while the directories are not
(`skill-select/`) — the bundle list keys off `package.json` `name`, which is why `exportsPatch`
resolves the dependency first.

### 5.4 Exact commands to add `dsh-port-manager`

```bash
# 1. Create the plugin files in the workspace (see §7).
cd "/Users/youngi/Documents/MiniWork/dsh插件/dsh-PortManager"

# 2. Make @deepseek-ai/cordis resolvable from the plugin dir — ONLY if your
#    host half does `import { Service } from "@deepseek-ai/cordis"`.
#    The object-plugin form in §1.4 needs none of this, and neither does the
#    implementation now in this directory: its only imports are node:* builtins
#    and the relative "./scan.js". If yours is the same, SKIP THIS STEP.
# mkdir -p node_modules/@deepseek-ai
# ln -sfn /Users/youngi/.dsh/profiles/node_modules/@deepseek-ai/cordis \
#   node_modules/@deepseek-ai/cordis

# 3. Install into the web profile: pnpm add link:<abs path> in the profile dir,
#    then automatic dsh.profile.bundles reconciliation.
dsh plugin --profile web add link:"/Users/youngi/Documents/MiniWork/dsh插件/dsh-PortManager"

# 4. Verify what changed.
node -e 'const p=require("/Users/youngi/.dsh/profiles/web/package.json");console.log(p.dependencies["dsh-port-manager"]);console.log(p.dsh.profile.bundles)'

# 5. Restart dsh web (see §5.5).
```

**`files[]` is a latent packaging bug in the current workspace `package.json`** — worth fixing even
though a `link:` install ignores it:

```json
"files": ["lib/index.js", "lib/client.js", "cordis.patch.yml", "dsh.plugin.json", "README.md"]
```

- `lib/scan.js` is **missing** from the list, and `lib/index.js` does
  `import { runCommand, scanPorts, splitCommand } from "./scan.js"`. A `pnpm pack` / `npm publish`
  would therefore ship a host half that cannot import. Add `"lib/scan.js"` (or `"lib"`).
- `dsh.plugin.json` and `README.md` are **listed but do not exist**. Harmless for `pnpm`, but
  either create them or drop them from the list. (`dsh.plugin.json` is not read by DSH at all —
  §6.2 — so dropping it is fine.)

Equivalent manual route (if you prefer to see every write):

```bash
cd /Users/youngi/.dsh/profiles/web
pnpm add link:/Users/youngi/Documents/MiniWork/dsh插件/dsh-PortManager
# then add "dsh-port-manager" to dsh.profile.bundles in package.json (reconcile does this for you
# when dsh.bundle.patch is declared), OR add the insert row to this profile's cordis.patch.yml.
```

`pnpm-workspace.yaml` in the profile is already configured for this
(`packages: [.]`, `nodeLinker: hoisted`, `autoInstallPeers: false`) — note
**`autoInstallPeers: false`** means your `peerDependencies` are *not* auto-installed, so do not
rely on them for anything the host half imports at runtime.

### 5.5 Restart vs live reload

Three independent mechanisms, and they reload different things:

1. **The profile's own `cordis.patch.yml` is live-watched.** The web template sets
   `patchReload: "live"` (`dsh-app-boot/lib/index.js:333-336`), and unspecified profiles default
   to `"live"` too (`dsh-app-boot/lib/index.js:848`:
   `const patchReload = rawPatchReload ?? "live";`). `runProfile` then mounts an HMR plugin if
   absent and watches the patch files (`lib/profile-boot-Dk-7KqJc.js:321-341`):

   ```js
   if (composed.profile.patchReload === "live" && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {
     if (ctx.get("hmr") === void 0) {
       if (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
       await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } });
     }
     await watchUserPatches(ctx, { binName: NAME, filename: composed.profile.patchPath, compose: composeLive });
     await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(), compose: composeLive });
   ```

   Editing `/Users/youngi/.dsh/profiles/web/cordis.patch.yml` **while `dsh web` runs** therefore
   re-composes and applies without a restart. (The base `hmr` row is `disabled: true` by default —
   `dsh-base/cordis.patch.yml:21-26` — but this code path creates its own instance.)
2. **Bundle layers are a boot-time snapshot.** `composeLive` closes over
   `...composed.bundlePatches` (`lib/profile-boot-Dk-7KqJc.js:310-315`), which was computed once in
   `composeProfile`. A **newly added plugin's own `cordis.patch.yml` is therefore NOT picked up
   live** — installing a new bundle package needs a `dsh web` restart.
   **⚠️ UNVERIFIED:** I did not run a live `dsh web` and edit the profile patch to confirm that an
   *already-installed but not-yet-listed* package mounts without restart. The code path reads the
   patch file fresh (`loadOptionalPatches(NAME, composed.profile.patchPath)`) and resolves the row
   by package name at load time, so it should — but treat it as a convenience, not the documented
   install path.
3. **Client-bundle HMR is separate and needs no server restart.** `dsh-client-hmr` stat-polls each
   graph row's bundle file and pushes SSE rebuild frames
   (`dsh-client-hmr/lib/index.js:10-16`, `bundleStat`/`rehash`/`watchRow` at lines 27-104, wired to
   `ctx.clientModules.artifactBaseline(row.id)` at line 94). Its own header says it is *"Dev-only
   hot-reload driver for script-loaded client entries: SSE rebuilt frames → invalidate/prefetch →
   fiber swap"*, and `dsh-web-app/cordis.patch.yml:166-168` mounts it unconditionally with the note
   *"The client-plugin reload chain, always mounted: it is idle until a rebuild watcher
   (`pnpm run dev:web`) actually rewrites client bundles."*

   So: for a **hand-written** plain-JS bundle, editing `lib/client.js` changes the file's mtime and
   the poll should push a reload to the open page — no rebuild watcher involved.
   **⚠️ UNVERIFIED at runtime.** `pnpm run dev:web` matters when a *build step* rewrites the bundle
   (that is the "rebuild watcher"); the DSH runtime prompt itself states this in
   `dsh-web-app/lib/index.js:92`, and it is echoed in this session's own runtime context:
   *"client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running
   from this same checkout to rebuild their bundles."* If you hand-write the bundle, you are the
   one rewriting it, so the watcher is unnecessary — but verify in the browser console before
   promising a refresh-free edit loop.

**Net answer:** for a **new** plugin, restart `dsh web`. For **iterating** on the host half, edit
the profile `cordis.patch.yml` or restart; for the **client** half, edit the file and let
`dsh-client-hmr` reload the page (or hard-refresh).

---

## 6. Pitfalls

### 6.1 Reserved names / collisions

- **Web route collisions throw.** Two rows registering the same `(kind, path)` raise
  `webserver: duplicate prefix route "…"` (`dsh-host-webserver/lib/index.js:178`). Namespace your
  path (`/port-manager/api`) — `/api` itself is owned by `dsh-client-connection`,
  `/plugins` by `dsh-client-modules`.
- **Cordis service names must be unique per context.** Loading a second provider of the same
  service throws — the canonical statement is in `dsh-shell`'s doc: *"one implementation per
  context; loading a second throws, which is cordis' standard duplicate-service behavior."* Pick
  `portManager` (camelCase, matching `workScope` / `skillSelect` / `webServer` conventions).
  Do **not** try to re-provide `shell`, `webServer`, `connection`, `clientModules`, `webRuntime`.
- **Loader row `id`** must be unique-ish; it is the override key for later patch layers. Existing
  ids in the web composition include `webserver`, `web-runtime`, `modules`, `connection`,
  `api-remotes`, `notebook`, `screenshot`, `skill-select`, `work-scope`. Use
  `port-manager`.
- **Client module id must equal the package name** — a mismatch surfaces as
  `require("…") missed the module table` in the browser
  (`dsh-client-modules/lib/client.js:308`).

### 6.2 `dsh.plugin.json`, `engines.dsh`, `contributes`

**`dsh.plugin.json` is not read by DSH 0.1.5-rc.2 at all.** A recursive grep for `plugin.json`
across the entire installed `@deepseek-ai/` tree returns **zero** matches, and the CLI
(`lib/*.js`) has zero matches for it too. `dsh-better-sidebar` ships **without** a
`dsh.plugin.json` and loads fine (`ls /Users/youngi/.dsh/profiles/web/node_modules/dsh-better-sidebar/`
→ no such file). Ship it as ecosystem convention/metadata (the four local plugins all have one),
but never rely on it for behavior.

Its fields, as the local plugins use them:

```json
{
  "id": "dsh-skill-select",
  "version": "0.1.1",
  "main": "./lib/index.js",
  "description": "…",
  "engines": { "dsh": "^0.1.0-rc.6 || ^0.1.5-rc.1" },
  "contributes": { "tools": [], "skills": [] },
  "client": { "main": "./lib/client.js" }
}
```

- `id` matches `package.json` `name` in all four; `dsh-notebook`'s header comment ties the two
  together: *"Cordis plugin name; the banner id in `dsh.plugin.json` must match it."*
  **Nothing enforces this** in 0.1.5-rc.2 — keep them equal anyway.
- `contributes` is inert. `{ "tools": [], "skills": [] }` in all four; nothing reads it.
- `engines.dsh` here is **not** consulted by DSH core. It **is** consulted by the third-party
  marketplace `dshmarket`, but only for npm manifests it fetches during discovery
  (`dshmarket/lib/discovery-compatibility.js:37-56`): it reads top-level `engines.dsh` **or**
  `dsh.engines.dsh` (`manifestFacts`), and it also mines `peerDependencies` for
  `@deepseek-ai/dsh-*` ranges. So a `peerDependencies` host range is what a marketplace uses to
  judge compatibility; keep it honest.
- **`dsh.plugin.json` `client.main` is decorative.** The real bundle path is
  `package.json` `exports["./client"]` (§4.1). Set both to the same file.

### 6.3 `type: module`

Required for the ESM syntax used by every plugin here (`import` / `export default` / `export
function apply`). All four plugin `package.json` files carry `"type": "module"`, and the loader
imports the entry as ESM (`unwrapExports` handles a CJS shape too, but only if the file is
actually CJS). Set `"type": "module"`.

### 6.4 Heavy dependencies

**Do not add them.** Concretely:

- The web profile installs with `nodeLinker: hoisted` and **`autoInstallPeers: false`**
  (`/Users/youngi/.dsh/profiles/web/pnpm-workspace.yaml`), so peer deps are not auto-provided.
- `@deepseek-ai/dsh-client-modules` **throws** if a package declares `dsh.client` without an
  `exports["./client"]` — a broken bundle reference fails the *whole* web boot, not one plugin.
- The client bundle **cannot import your own sibling files** or any Node-side package
  (`dsh-screenshot/lib/client.js:8`; `dsh-work-scope/lib/typert.remote-client.js:4-5`). Anything
  the browser half needs must be inlined or reached via `require()` of a package that is in the
  module table (i.e. a platform seed like `react`/`react-dom`, or a package you listed in
  `dsh.client.inject`).
- `dsh-skill-select` has exactly one runtime dep (`yaml`), `dsh-work-scope` one (`zod`),
  `dsh-screenshot` none. Stay in that weight class.

### 6.5 Module resolution from a `link:`ed plugin directory

A real trap. Node resolves a bare import relative to the module's **real path**, and the plugin
directory lives outside the profile:

```
/Users/youngi/Documents/MiniWork/dsh插件/dsh-PortManager/lib/index.js
  → looks for node_modules/ up the chain:
    …/dsh-PortManager/node_modules        (does not exist by default)
    …/dsh插件/node_modules                 (does not exist)
    …/MiniWork/node_modules                (does not exist)
    /Users/youngi/node_modules             (does not exist)
```

I verified all four are absent, and verified the working plugins work around it by carrying their
own symlinks, e.g.:

```
skill-select/node_modules/@deepseek-ai/cordis
  -> /Users/youngi/.dsh/profiles/node_modules/@deepseek-ai/cordis
skill-select/node_modules/yaml -> /Users/youngi/.dsh/profiles/node_modules/yaml
dsh-screenshot/node_modules/@deepseek-ai/dsh-settings -> …/profiles/node_modules/@deepseek-ai/dsh-settings
dsh-notebook/node_modules/  (a full pnpm install: .pnpm/, .modules.yaml, 246 entries)
```

Two clean options: **(a)** write the host half as the zero-import object plugin of §1.4 — nothing
to resolve; or **(b)** create the one symlink shown in §5.4 step 2. Do not assume a plain
`link:` install gives you `@deepseek-ai/cordis`.

**The implementation now in this directory is immune to this trap.** Its only host-half imports are

```js
import { existsSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { runCommand, scanPorts, splitCommand } from "./scan.js";   // relative — always resolves
import { execFile } from "node:child_process";                     // in lib/scan.js
```

— `node:*` builtins plus one relative file. There is no `node_modules/` in the plugin directory and
none is needed; the client bundle's single `require("react")` is answered by the browser seed table,
not by Node. Verify the same invariant before adding any `@deepseek-ai/*` import.

### 6.6 How load errors surface

- **Stderr, loudly.** `installFailLoud` (`dsh-app-boot/lib/index.js:1401-1428`) installs an
  `unhandledRejection` handler that prints
  `dsh: fatal load failure: <stack>` and exits 1.
- **Named-plugin summary.** `assertEntriesLoaded` (`dsh-app-boot/lib/index.js:1436-1441`):
  ```js
  throw new Error(`${binName}: plugin(s) failed to load: ${names}; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)`);
  ```
  and `assertEntriesActivated` (line 1460+) awaits each failed fiber to recover its rejection
  reason.
- **Log files on this machine** (`ls -la /Users/youngi/.dsh/`):
  - `/Users/youngi/.dsh/dsh-web-startup.error.log`
  - `/Users/youngi/.dsh/dsh-web-startup.log`
  - `/Users/youngi/.dsh/dsh-web-startup.tty.log`

  Current contents recorded during this research — the error log holds
  `dsh web URL was not announced within 60 seconds; inspect private tty log.` and the tty log holds
  the `dsh web: http://127.0.0.1:3080/?token=…` line.

  **Important:** these paths are **not** written by DSH. Grepping the entire DSH tree for
  `startup.error` / `startup.tty` finds nothing (the only `startup-error` hits are
  `dsh-subprocess-local`'s unrelated `startup-error.json`). They are written by whatever launches
  `dsh web` on this machine (`/Users/youngi/.local/bin/dsh` is a bare symlink to
  `…/@deepseek-ai/dsh/lib/bin.js`, so the wrapper is external — a Hermes/GUI launcher). Treat them
  as "where this box's launcher puts stdout/stderr", and reproduce by running `dsh web` in a
  terminal to see the same text live.
- **Client-side failures** are browser-console only: `dsh-skill-select/lib/client.js` logs
  `[dsh-skill-select] list failed: …`, `[dsh-skill-select] tab registration failed: …`. The shell's
  own boot audit then reports, per entry:
  - `<pkg>: import failed (see console for the import error)` — a factory threw, most often the
    `require("…") missed the module table` error (`dsh-client-modules/lib/client.js:308`);
  - `<pkg>: pending (waiting for service(s): …)` — a declared `exports.inject` service never
    appeared;
  - `<pkg>: failed` — set when `loaderApi.resolve(fiber).fiber === undefined`;
  - ending in a throw: `web boot: N entries did not activate` plus one line per entry.
- **Host-side client-composition failures are boot-fatal**, before any page is served:
  `client-modules: N client package(s) failed to compose:` … or
  `client-modules: client bundle not found; run \`pnpm run build\` before launch:` with
  `package:` / `path:` lines (`dsh-client-modules/lib/index.js:91-120`, `:750-764`).

### 6.7 Other things that will bite

- **`ctx.effect` is not optional.** Every route/subscription registration must return a disposer
  through `ctx.effect`, or a reload throws `duplicate prefix route`.
- **Undeclared service access throws.** `ctx.sandboxPolicy` style property access without
  `inject` fails in DSH 0.1.5 — `dsh-screenshot/lib/client.js:806`:
  *"未声明就裸访问服务属性在 DSH 0.1.5 会抛 `cannot get property \"sessions\" without inject`"*.
  Use `ctx.get("x")` for optional services.
- **`require()` of a non-seed package in the client bundle kills the whole bundle.** Same comment,
  `dsh-skill-select/lib/client.js:122-125`: *"DSH 0.1.5 起 `@deepseek-ai/dsh-client-runtime` 不再是
  模块表种子包，`require()` 它会以 \"missed the module table\" 炸掉整个 client bundle"*.
- **Validate before you kill.** Coerce `pid` with `Number.isSafeInteger(pid) && pid > 0` and refuse
  `pid === 1`, `pid === process.pid`, and any pid you did not just list. `process.kill` with a bad
  pid throws `ESRCH`/`EPERM`; map those to 404/403 in your envelope rather than a blanket 500.
- **macOS `netstat -anv -p TCP` does not put the pid in the last column.** The owner token is
  `name:pid` (`node:1276`, `com.metacubex.Cl:7786`) at a shape-dependent position; taking
  `columns[columns.length - 1]` yields a hex counter and **every pid parses as null**. Find it by
  shape instead (the only token containing a colon after the state column) — see the corrected
  `parseNetstat` in §7.4, which was verified against real output on this machine.
- **Prefer `lsof`.** On macOS `lsof -nP -iTCP -sTCP:LISTEN` gives name+pid+user in one call and
  was correct on the first attempt; netstat is the fallback, needs a shape-based pid lookup, and
  omits the user. Pin the absolute path (`/usr/sbin/lsof`) — `execFile` reports `ENOENT` if PATH
  is unusual, which is exactly what the `LSOF_CANDIDATES` loop handles.

---

## 7. Complete minimal `dsh-port-manager` files

> **Note on this workspace.** While this recipe was being written, the plugin was implemented in
> this directory along a **native right-sidebar tab** architecture (`lib/index.js`, `lib/client.js`,
> `lib/scan.js`; `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-sidebar-right"]`). §7.1–§7.6 below
> are the *minimal reference* implementation (standalone mount, `inject: []`) and remain the
> smallest correct starting point. §7.0 records the **verified** facts for the sidebar-right route
> that the workspace implementation actually uses — every host-side rule in §1–§3 applies unchanged
> to both.

### 7.0 Verified facts for the native right-sidebar tab route

If the client half registers a tab in the shipped right sidebar instead of mounting its own DOM:

- **`@deepseek-ai/dsh-client-ui-sidebar-right` is a real Loader row** in the web composition
  (`dsh-web-app/cordis.patch.yml`, `- id: ui-sidebar-right / name: '@deepseek-ai/dsh-client-ui-sidebar-right'`),
  so listing it in `dsh.client.inject` is valid and does preload its factory.
- **It provides two services** (`dsh-client-ui-sidebar-right/lib/client.js:3667-3668`):
  ```js
  const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);
  const disposeService  = ctx.reflect.provide("sidebarRight", controller);
  ```
  Those are **service names**, so the bundle must declare
  `exports.inject = ["slots", "sidebarRightTabs"]` (add `"sidebarRight"` for the controller).
  Declaring a name that is never provided yields
  `<pkg>: pending (waiting for service(s): …)` and a failed boot — verify names, never guess.
- **`register(definition)`** on `SidebarRightTabRegistry` (`…/lib/client.js:3330-3360`):
  > *"Register one tab type for the caller's lifetime. The caller holds the returned disposer
  > inside its own `ctx.effect`… An `extension` may register a kind a `builtin` already holds and
  > takes it over until it unregisters; a second registration in the same band, or any registration
  > meeting a `fallback` of the same kind, is a wiring mistake, and so is an `id` already in use."*
  > `@returns idempotent disposer.` `@throws when the id is taken…`

  So: wrap it in `ctx.effect` (the parent implementation does), and treat `id` as globally reserved.
- **`sidebar.right.pane.tab` is a real slot name** (`…/lib/client.js:650`, `:651`, `:721`); the tab
  body registers there keyed by the type's `id`.
- **`ctx.effect` is available and idiomatic in client bundles** — the shipped
  `dsh-client-ui-sidebar-right` and `dsh-client-ui-sidebar-files` bundles each use it 4 times.

The workspace implementation follows all of the above, plus every host-side rule in §2 and §3
(prefix route on `/port-manager/api`, `isTrustedRequest` fence reading
`ctx.get("webRuntime")?.trustedHosts`, registration inside `ctx.effect`, `process.kill` for the
kill path).

### 7.1 `package.json`

```json
{
  "name": "dsh-port-manager",
  "version": "0.1.0",
  "description": "DSH web plugin: list listening TCP ports and terminate the owning processes.",
  "type": "module",
  "license": "MIT",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "lib/logic.js",
    "cordis.patch.yml",
    "dsh.plugin.json",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": []
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-host-webserver": "^0.1.5-rc.1"
  }
}
```

Notes: `exports["./client"]` is what makes the browser half loadable (§4.1) — the filename is
irrelevant, the key is not. `dsh.client.inject: []` because this version mounts its own DOM and
consumes no other client package's service; raise it (and add `exports.inject` in the bundle) the
moment you register into a real Slot. `peerDependencies` is documentation + marketplace
compatibility signal (§6.2) and is **not** auto-installed (`autoInstallPeers: false`).

### 7.2 `dsh.plugin.json`

```json
{
  "id": "dsh-port-manager",
  "version": "0.1.0",
  "main": "./lib/index.js",
  "description": "List listening TCP ports and terminate the owning processes.",
  "engines": {
    "dsh": "^0.1.5-rc.1"
  },
  "contributes": {
    "tools": [],
    "skills": []
  },
  "client": {
    "main": "./lib/client.js"
  }
}
```

Metadata only in 0.1.5-rc.2 (§6.2). Keep `id` equal to `package.json` `name`, and `client.main`
equal to the `exports["./client"]` target.

### 7.3 `cordis.patch.yml`

```yaml
# dsh-port-manager bundle patch
#
# Mounts the host half as a profile loader row. `dsh plugin --profile web add
# link:<this dir>` installs the package and appends "dsh-port-manager" to the
# profile's dsh.profile.bundles, which is what pulls THIS file in as a patch
# layer. Manual installs add the same row to the profile's cordis.patch.yml.
- insert:
    - id: port-manager
      name: 'dsh-port-manager'
```

### 7.4 `lib/index.js` — host half

Zero runtime imports; uses `node:child_process` only inside Node built-ins and `process.kill`.

```js
/**
 * dsh-port-manager — host half.
 *
 * Registers the fenced JSON API under /port-manager/api and the `portManager`
 * service. Two methods:
 *   list { }                  → { ports: [{ pid, process, user, proto, address, port }] }
 *   kill { pid, signal? }     → { pid, signal, killed: true }
 *
 * The browser half (`lib/client.js`) calls these with same-origin fetch.
 *
 * Trust: this route sits on the DSH web server but OUTSIDE the /api gateway, so
 * it receives no framework authentication. isTrustedRequest() below is the
 * entire fence — see README for why that matters on a kill endpoint.
 *
 * @module dsh-port-manager
 */
import { execFile } from "node:child_process";

export const name = "dsh-port-manager";
export const inject = ["webServer"];

// ── wire helpers ───────────────────────────────────────────────────────────

export class PortManagerApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new PortManagerApiError("bad-request", "request body too large", 413);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new PortManagerApiError("bad-request", "request body is not valid JSON");
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

const writeOk = (res, value) => writeJson(res, 200, { ok: true, value });

function writeError(res, error) {
  if (error instanceof PortManagerApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  writeJson(res, 500, {
    ok: false,
    error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
  });
}

// ── trust fence ────────────────────────────────────────────────────────────
// Same loopback + trusted-host + sec-fetch-site + Origin checks the /api
// gateway applies (see @deepseek-ai/dsh-client-connection isTrustedApiRequest).
// This route gets no framework auth, so this function IS the security boundary.

export function isTrustedRequest(req, trustedHosts = []) {
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
      && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  };
  const trusted = trustedHosts.some((entry) => {
    try {
      const e = new URL(`http://${entry}`);
      const ePort = e.port || new URL(`https://${entry}`).port;
      const hPort = hostUrl.port || new URL(`https://${host}`).port;
      if (ePort === "" || hPort === "") return e.hostname === hostUrl.hostname;
      return e.host === hostUrl.host;
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

// ── port enumeration ───────────────────────────────────────────────────────
// `execFile` (never `exec`): no shell is spawned, so the fixed argv cannot be
// reinterpreted as shell syntax.

const LSOF_CANDIDATES = ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"];

function runFile(file, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null && error !== undefined && stdout === "") return reject(error);
      resolve(stdout);
    });
  });
}

/** macOS/BSD `lsof -nP -iTCP -sTCP:LISTEN` → one record per listening socket. */
export function parseLsof(stdout) {
  const ports = [];
  for (const line of String(stdout).split("\n")) {
    if (line.trim() === "" || line.startsWith("COMMAND")) continue;
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9) continue;
    const [command, pidRaw, user, , , , , , name] = columns;
    const pid = Number.parseInt(pidRaw, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    // NAME looks like: 127.0.0.1:3080  |  *:5432  |  [::1]:8080  |  [::]:5432
    const match = /^(.*):(\d+)$/.exec(name);
    if (match === null) continue;
    ports.push({ pid, process: command, user, proto: "tcp", address: match[1], port: Number.parseInt(match[2], 10), ...binding(match[1]) });
  }
  return ports;
}

/**
 * Classify a bind address. `*` / `0.0.0.0` / `[::]` mean "every interface" —
 * the interesting case for a port manager, since that is what is reachable from
 * the network. Kept as two explicit booleans so the UI never has to re-parse.
 */
export function binding(address) {
  const allInterfaces = address === "*" || address === "0.0.0.0" || address === "[::]";
  const loopbackOnly = !allInterfaces
    && (address.startsWith("127.") || address === "[::1]" || address === "localhost");
  return { exposed: allInterfaces, loopbackOnly };
}

async function listListeningPorts() {
  let lastError;
  for (const candidate of LSOF_CANDIDATES) {
    try {
      const stdout = await runFile(candidate, ["-nP", "-iTCP", "-sTCP:LISTEN"]);
      return { ports: parseLsof(stdout), source: candidate, self: process.pid };
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT") break;
    }
  }
  // Fallback: netstat is always present on macOS and needs no privileges.
  try {
    const stdout = await runFile("netstat", ["-anv", "-p", "TCP"]);
    return { ports: parseNetstat(stdout), source: "netstat", self: process.pid };
  } catch {
    throw new PortManagerApiError(
      "no-tool",
      `no port lister available: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      500,
    );
  }
}

/**
 * `netstat -anv -p TCP` fallback (macOS).
 *
 * Column layout is
 *   Proto Recv-Q Send-Q Local Foreign (state) rxbytes txbytes rhiwat shiwat
 *   process:pid state options gencnt flags flags1 usecnt rtncnt fltrs
 * so the pid is NOT the last column — it is the `name:pid` token, found by
 * shape. Verified against real `netstat -anv -p TCP` output on this machine.
 */
export function parseNetstat(stdout) {
  const ports = [];
  for (const line of String(stdout).split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 11) continue;
    if (columns[0] !== "tcp4" && columns[0] !== "tcp6") continue;
    if (columns[5] !== "LISTEN") continue;
    const match = /^(.*)\.(\d+)$/.exec(columns[3]);
    if (match === null) continue;
    // `name:pid` is the only token with a colon; scan past the state column.
    let pid = null;
    let process = "unknown";
    for (let i = 6; i < columns.length; i += 1) {
      const owner = /^(.+):(\d+)$/.exec(columns[i]);
      if (owner !== null) {
        const parsed = Number.parseInt(owner[2], 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) { pid = parsed; process = owner[1]; }
        break;
      }
    }
    const proto = columns[0] === "tcp6" ? "tcp6" : "tcp";
    const address = match[1] === "*" ? (proto === "tcp6" ? "[::]" : "0.0.0.0") : match[1];
    ports.push({ pid, process, user: null, proto, address, port: Number.parseInt(match[2], 10), ...binding(address) });
  }
  return ports;
}

// ── kill ───────────────────────────────────────────────────────────────────

const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT"]);

/** Built-in process.kill — no subprocess, no shell, no sandbox question. */
export function killProcess(pid, signal = "SIGTERM") {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new PortManagerApiError("bad-request", "missing or invalid \"pid\"");
  }
  if (!SIGNALS.has(signal)) {
    throw new PortManagerApiError("bad-request", `unsupported signal "${signal}"`);
  }
  // Never let a UI accident take down the harness or the OS.
  if (pid === process.pid || pid === 1) {
    throw new PortManagerApiError("forbidden", `refusing to signal pid ${pid}`, 403);
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") throw new PortManagerApiError("not-found", `no process with pid ${pid}`, 404);
    if (error?.code === "EPERM") throw new PortManagerApiError("forbidden", `not permitted to signal pid ${pid}`, 403);
    throw error;
  }
  return { pid, signal, killed: true };
}

// ── plugin ─────────────────────────────────────────────────────────────────

const API_PREFIX = "/port-manager/api";

export function apply(ctx, config = {}) {
  const prefix = typeof config.prefix === "string" && config.prefix !== "" ? config.prefix : API_PREFIX;

  // The service is the host-side surface: another row can `ctx.get("portManager")`
  // (or declare `inject: ["portManager"]`) and call these without going through HTTP.
  // `ctx.provide` registers its own disposer on this fiber.
  const portManager = {
    async list() {
      return listListeningPorts();               // { ports, source, self }
    },
    async kill(pid, signal = "SIGTERM") {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new PortManagerApiError("bad-request", "missing or invalid \"pid\"");
      }
      return killProcess(pid, signal);
    },
    ping: () => ({ pong: true, pid: process.pid }),
  };
  ctx.provide("portManager", portManager);

  const dispatch = (method, payload) => {
    switch (method) {
      case "list":
        return portManager.list();
      case "kill":
        return portManager.kill(Number(payload?.pid), typeof payload?.signal === "string" ? payload.signal : "SIGTERM");
      case "ping":
        return portManager.ping();
      default:
        throw new PortManagerApiError("not-found", `unknown port-manager API method "${method}"`, 404);
    }
  };

  const handler = async (req, res) => {
    const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];
    if (!isTrustedRequest(req, trustedHosts)) {
      writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
    const method = pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length + 1) : undefined;
    if (method === undefined || method === "" || method.includes("/")) {
      writeError(res, new PortManagerApiError("not-found", "unknown port-manager API method", 404));
      return;
    }
    try {
      writeOk(res, await dispatch(method, await readJsonBody(req)));
    } catch (error) {
      writeError(res, error);
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: prefix,
    handler,
  }), "port-manager: api route");
}
```

### 7.5 `lib/client.js` — hand-written browser bundle

Self-contained; `require`s only the platform seed `react`/`react-dom`. If you would rather not
touch React, replace `mount()` with plain `document.createElement` + `addEventListener`.

```js
/**
 * dsh-port-manager — client half (web ModuleLoader bundle).
 *
 * Hand-written: no build step. `id` MUST equal the package name, and the
 * factory is CommonJS-shaped (`module.exports`). This file cannot import its
 * own sibling modules — anything shared must be inlined.
 */
window.__ModuleLoader__.load({
  id: "dsh-port-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const ReactDOM = require("react-dom");

    async function apiCall(method, payload) {
      let response;
      try {
        response = await fetch(`/port-manager/api/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
      } catch (error) {
        throw new Error(`network: ${error instanceof Error ? error.message : String(error)}`);
      }
      const parsed = await response.json().catch(() => null);
      if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
      }
      return parsed.value;
    }

    function Panel() {
      const [state, setState] = React.useState({ loading: true, ports: [], error: null, self: null });
      const refresh = React.useCallback(async () => {
        setState((s) => ({ ...s, loading: true, error: null }));
        try {
          const value = await apiCall("list", {});
          setState({ loading: false, ports: value.ports ?? [], error: null, self: value.self ?? null });
        } catch (error) {
          setState({ loading: false, ports: [], error: String(error.message ?? error), self: null });
        }
      }, []);
      React.useEffect(() => { refresh(); }, [refresh]);

      const kill = async (pid, signal) => {
        try {
          await apiCall("kill", { pid, signal });
          await refresh();
        } catch (error) {
          setState((s) => ({ ...s, error: String(error.message ?? error) }));
        }
      };

      return React.createElement("div", { style: { padding: 12, fontSize: 12 } },
        React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          React.createElement("strong", null, "Listening ports"),
          React.createElement("button", { onClick: refresh, disabled: state.loading }, "Refresh"),
        ),
        state.error !== null
          ? React.createElement("div", { style: { color: "#e5534b", marginTop: 8 } }, state.error)
          : null,
        React.createElement("ul", { style: { listStyle: "none", padding: 0, marginTop: 8 } },
          state.ports.map((p) => React.createElement("li", {
            key: `${p.pid}-${p.port}`,
            style: { display: "flex", gap: 8, alignItems: "center", padding: "2px 0" },
          },
            React.createElement("code", null, `:${p.port}`),
            p.exposed
              ? React.createElement("span", { style: { color: "#e6a23c" }, title: "bound to every interface — reachable from the network" }, "exposed")
              : null,
            React.createElement("span", { style: { opacity: 0.7 } }, `${p.process} (${p.pid})`),
            p.pid === state.self ? React.createElement("em", null, "this harness") : null,
            React.createElement("button", {
              onClick: () => kill(p.pid, "SIGTERM"),
              disabled: p.pid === state.self || p.pid === null,
            }, "Kill"),
          )),
        ),
      );
    }

    function mount() {
      if (typeof document === "undefined") return undefined;
      const container = document.createElement("div");
      container.id = "dsh-port-manager-root";
      document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      root.render(React.createElement(Panel, null));
      return () => {
        try { root.unmount(); } catch { /* ignore */ }
        try { container.remove(); } catch { /* ignore */ }
      };
    }

    function apply(ctx) {
      // No UI slot is claimed here. Register into a real surface (e.g.
      // dsh-better-sidebar's registerTab, or a ui-slots slot) once the target
      // is decided — see §4.5 of the recipe. Until then this mounts its own DOM.
      const dispose = mount();
      return () => { if (typeof dispose === "function") dispose(); };
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
```

### 7.6 Optional `lib/logic.js`

Keep pure parsers here **for `node --test`** and inline copies in `lib/client.js` — the browser
bundle cannot import them (`dsh-screenshot/lib/client.js:8`). `dsh-screenshot` ships exactly this
split (`lib/logic.js` + an inlined copy in `lib/client.js`) and `node --check lib/index.js && node
--check lib/client.js` as its `scripts.check` (`dsh-skill-select/package.json`).

---

## 8. Install and verification commands

```bash
PLUGIN="/Users/youngi/Documents/MiniWork/dsh插件/dsh-PortManager"
PROFILE="/Users/youngi/.dsh/profiles/web"

# 0. Syntax check before installing anything.
node --check "$PLUGIN/lib/index.js"
node --check "$PLUGIN/lib/client.js"

# 1. (only if the host half imports @deepseek-ai/cordis — §6.5)
mkdir -p "$PLUGIN/node_modules/@deepseek-ai"
ln -sfn "$PROFILE/../node_modules/@deepseek-ai/cordis" "$PLUGIN/node_modules/@deepseek-ai/cordis"

# 2. Install + reconcile into the web profile.
dsh plugin --profile web add link:"$PLUGIN"

# 3. Verify the two writes the CLI makes.
node -e 'const p=require("'"$PROFILE"'/package.json");
  console.log("dep    :", p.dependencies["dsh-port-manager"]);
  console.log("bundles:", p.dsh.profile.bundles);'
ls -l "$PROFILE/node_modules/dsh-port-manager"      # -> symlink to $PLUGIN

# 4. Verify the composed tree actually contains the row (no server binds).
#    NOTE: any dsh boot/dump call REWRITES the profile's cordis.yml (the empty
#    root config) as a side effect — see prepareProfile in lib/profile-boot-Dk-7KqJc.js,
#    "The root is always rewritten ... to avoid duplicating every bundle insert
#    on the next boot." The content is the fixed empty-list header, so this is
#    idempotent, not a loss of your edits (which belong in cordis.patch.yml).
dsh --profile web --dump-config | grep -B1 -A2 -i "port-manager"
#    or, to see only the bundle layers (no user layer):
dsh --profile web --dump-default-config | grep -i port-manager

# 5. Restart the GUI (a new bundle layer is a boot-time snapshot — §5.5).
dsh web
#    watch stderr for:  dsh: plugin(s) failed to load: … / dsh: fatal load failure: …

# 6. Smoke-test the API from the shell (the fence requires a loopback Host and
#    no cross-site Sec-Fetch-Site, which curl satisfies by default).
curl -sS -X POST http://127.0.0.1:3080/port-manager/api/ping \
  -H 'content-type: application/json' -d '{}'
# → {"ok":true,"value":{"pong":true,"pid":…}}

curl -sS -X POST http://127.0.0.1:3080/port-manager/api/list \
  -H 'content-type: application/json' -d '{}'
# → {"ok":true,"value":{"ports":[…],"source":"/usr/sbin/lsof","self":…}}

# 7. Verify the fence rejects a foreign Origin.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/port-manager/api/list \
  -H 'content-type: application/json' -H 'Origin: https://evil.example' -d '{}'
# → 403

# 8. In the browser: open the URL `dsh web` printed, check DevTools console for
#    "[dsh-port-manager] …" and Network for the /port-manager/api/list 200.
```

Uninstall / rollback:

```bash
dsh plugin --profile web remove dsh-port-manager
#    → pnpm remove + reconcile strips it from dsh.profile.bundles
# then restart dsh web
```

---

## 9. Evidence index (key citations)

| Fact | Evidence |
|---|---|
| Class plugin → `new X(ctx, config)`, then `Service.init` | `@deepseek-ai/cordis/lib/index.js:1066-1070` |
| Object plugin needs `.apply`; else throws | `@deepseek-ai/cordis/lib/index.js:1526-1538`, `:1620` |
| `mod.default ?? mod` normalization | `@deepseek-ai/cordis-plugin-loader/lib/index.js:745-751` |
| `Config` optional | `@deepseek-ai/cordis/lib/index.js:955-957` |
| `WebRoute` = `{kind:'exact'\|'prefix', path, handler(req,res)}` | `dsh-host-webserver/lib/types/index.d.ts:30-38` |
| Duplicate route throws | `dsh-host-webserver/lib/index.js:176-185` |
| `/api` gate: fence **and** browser cookie | `dsh-client-connection/lib/index.js:553-556`, `:386-404` |
| Plugin fence copied from the gateway | `dsh-skill-select/lib/index.js:444-481` |
| `trustedHosts` from `webRuntime` | `dsh-web-app/lib/index.js:30`, `:173`, `:83-89`; `dsh-skill-select/lib/index.js:1066` |
| JSON body/response/error helpers | `dsh-skill-select/lib/index.js:483-520`, `:436-442` |
| Client `apiCall` (URL/method/headers) | `dsh-skill-select/lib/client.js:149-165` |
| REST-style alternative + envelope | `dsh-notebook/lib/index.js:946-961`, `:1335-1392` |
| Typert host/remote transport | `dsh-work-scope/lib/typert.host.js:36-155`, `lib/typert.remote-client.js:32-144`, `lib/index.js:16,326-330,394-396` |
| `ctx.shell` seam surface | `dsh-shell/lib/types/index.d.ts:62,69,75`; `dsh-shell/lib/index.js:86` |
| `bash-sandbox` is a host-plane provider | `dsh-base/cordis.patch.yml:214-218`; `dsh-bash-sandbox/lib/index.js:111-118` |
| Sandbox default mode | `dsh-base/cordis.patch.yml` (`sandbox-policy`, `DSH_PERMISSION_MODE ?? 'workspace-write'`) |
| Plugins use `node:child_process` directly | `dsh-skill-select/lib/index.js:29-30,371,388-397,413-415`; `dsh-better-sidebar/lib/index.js:980,1089` |
| Bundle path = `exports["./client"]`, not `dsh.client.main` | `dsh-client-modules/lib/index.js:649-656` (`clientExportOf`) |
| `platform` must be `"web"`; missing `./client` throws | `dsh-client-modules/lib/index.js:650-655` |
| Bundle URL + row shape | `dsh-client-modules/lib/index.js:182-184`, `:326-337` |
| `WebBootEntry` / `WebBootGraph` wire types | `dsh-client-modules/lib/types/client/manifest.d.ts:38-59`, `:73-85` |
| `/plugins` prefix route + `__DSH_BOOT__` index tap | `dsh-client-modules/lib/index.js:480-491`, `:387-432` |
| Index row → HTML (incl. `\u003c` escaping) | `dsh-host-webserver/lib/index.js:24-52` |
| Bundle serving: GET/HEAD, immutable cache, 404 on stale rev | `dsh-client-modules/lib/index.js:857-871`, `:208-221` |
| Client-composition fatal errors + build instruction | `dsh-client-modules/lib/index.js:91-120`, `:750-764` |
| `exports["./client"]` reader | `dsh-client-modules/lib/index.js:156-166` |
| `dsh.client` field validation | `dsh-client-modules/lib/index.js:139-152` |
| Freeze/order by `external`; self-request + cycle throw | `dsh-client-modules/lib/index.js:349-371` |
| Browser arrival loop: `external` then `inject` (silent on miss) | `dsh-client-modules/lib/client.js:252-270` |
| `register()` duplicate-factory guard; `arrive()` registration check | `dsh-client-modules/lib/client.js:228-251` |
| `materialize()`: factory return value IS exports | `dsh-client-modules/lib/client.js:271-293` |
| Seed table (9 `require`-able specifiers) | shell dist `…/dsh-web-frontend/dist/assets/index-*.js` (`staticModules`) |
| Module-table miss error | `dsh-client-modules/lib/client.js:308` |
| Classic-script transport | `dsh-client-modules/lib/client.js:145-159` |
| `id` normalization (`<pkg>/client` accepted) | `dsh-client-modules/lib/client.js:61-63` |
| `immediately` prefetch, failures swallowed | shell dist `prefetchImmediateTier`; `client.js:325` |
| HMR SSE endpoint `/plugins/events` | `dsh-client-hmr/lib/index.js:5`, `:134-148` |
| `/api` route + envelope + 415 on bad content type | `dsh-client-connection/lib/index.js:13`, `:501-515`, `:635-678`, `:767-781` |
| `ctx.connection.rpc.call` unary POST | `dsh-client-connection/lib/client.js:6194-6218` |
| Remote unary → `/api/<ns>/<method>`; streams → `/api/remote.mux` | `dsh-api-gateway/lib/client.js:1627-1628`, `:48-49`, `:402` |
| Strict-codec requirement | `dsh-api-gateway/lib/client.js:1823-1838` |
| `dsh-api-remotes` browser half = `$mount` assembly | `dsh-api-remotes/lib/client.js:9633-9671`; node `lib/index.js:96-131` |
| Cookie attrs (`HttpOnly; SameSite=Strict`) | `dsh-client-connection/lib/index.js:292-294` |
| Hand-written bundle header/footer | `dsh-skill-select/lib/client.js:19-27,1184-1205`; `dsh-screenshot/lib/client.js:10-17` |
| Bundle cannot import local ESM | `dsh-screenshot/lib/client.js:8`; `dsh-work-scope/lib/typert.remote-client.js:4-5` |
| No build step needed (plain JS); notebook's tsdown is optional | `dsh-skill-select/package.json`, `dsh-screenshot/package.json`, `dsh-work-scope/package.json` vs `dsh-notebook/package.json` (`scripts.build`) |
| `dsh plugin` = pnpm forwarder + bundle reconcile | `lib/plugin-Ddi42qoW.js:8-16`, `:45-79`, `:88-95`, `:105-118` |
| CLI grammar / no `list` subcommand | `lib/bin.js:41`, `:105-114` |
| Bundle layer = `dsh.bundle.patch` of the package | `lib/plugin-Ddi42qoW.js:20-32`, `:45-79`; `lib/profile-boot-Dk-7KqJc.js:240` |
| Patch stack order | `lib/profile-boot-Dk-7KqJc.js:212-220`, `:242-248` |
| `patchReload` defaults to `live`; web template `live` | `dsh-app-boot/lib/index.js:333-336`, `:848` |
| Live patch watcher + auto HMR mount | `lib/profile-boot-Dk-7KqJc.js:310-341` |
| Base `hmr` row disabled by default | `dsh-base/cordis.patch.yml:21-26` |
| `client-hmr` polls bundle mtimes → SSE | `dsh-client-hmr/lib/index.js:10-16,27-104`; `dsh-web-app/cordis.patch.yml:166-168` |
| Fail-loud + named-plugin load error | `dsh-app-boot/lib/index.js:1401-1428`, `:1436-1441`, `:1460+` |
| `dsh.plugin.json` / `contributes` read by nothing | recursive grep over `@deepseek-ai/**` → 0 hits; `dsh-better-sidebar` ships without one |
| `engines.dsh` read only by the third-party market | `dshmarket/lib/discovery-compatibility.js:37-56` |
| Web profile pnpm config (`autoInstallPeers: false`) | `/Users/youngi/.dsh/profiles/web/pnpm-workspace.yaml` |
| Plugin-dir `node_modules` symlink workaround | `skill-select/node_modules/@deepseek-ai/cordis`, `dsh-screenshot/node_modules/@deepseek-ai/dsh-settings` |
| Startup log files (written by an external launcher) | `/Users/youngi/.dsh/dsh-web-startup{,.error,.tty}.log`; 0 hits for those names inside DSH |

## 10. What was verified by execution vs. read from source

Everything in §1–§6 is read from the installed source with the cited `file:line`. In addition, the
**exact code in §7.1–§7.6 was extracted from this document and executed** — the harness lives in
`verification/` and re-extracts from this file, so it always tests what the report actually says:

```bash
node verification/extract.mjs && node --check verification/index.mjs && node --check verification/client.js
node verification/test.mjs && node verification/netstat.test.mjs && node verification/client.test.mjs
```

| Check | Result |
|---|---|
| `node --check` on §7.4 `lib/index.js` | pass |
| `node --check` on §7.5 `lib/client.js` | pass (classic-script syntax, no ESM) |
| `parseLsof` against real `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN` | 23 listening sockets parsed; `source: "/usr/sbin/lsof"` |
| `parseNetstat` against real `netstat -anv -p TCP` | 27 LISTEN rows, **27/27 pids + process names resolved**, 9 `exposed`, 17 `loopbackOnly` |
| `isTrustedRequest` — loopback / localhost / `[::1]` / cross-site / foreign Origin / non-loopback / trustedHosts / missing Host | 8/8 as expected |
| `killProcess` guardrails — `0`, `-1`, `1.5`, `"abc"`, `null`, `undefined`, `NaN`, `pid 1`, `process.pid`, bad signal, `ESRCH` → 404 | 11/11 as expected |
| Route handler with a mock `ctx` — `prefix` kind, path, disposer, `ping`, `kill`→403 for self, unknown method→404, nested path→404, bad JSON→400, `GET`→405, cross-site→403, foreign Origin→403, `list`→200 | 12/12 as expected |
| `ctx.provide("portManager", …)` surface — `list()` returned 23 real ports, `kill(-5)` rejected | as expected |
| Client bundle under a stubbed `window.__ModuleLoader__` + seed `require` | registers 1 module, `id === "dsh-port-manager"`, `factory()` returns exports with callable `apply` and array `inject`, `apply()` mounts and returns a working disposer |

**Total: 36/36 assertions pass.** The `netstat` pid-column bug found by this run is fixed in §7.4.

Two bugs were found **by running the code** rather than reading it, and are fixed above:

1. `parseNetstat` assumed the pid was the last column. On macOS it is the `name:pid` token at a
   shape-dependent position, so **every pid silently parsed as `null`**. Now located by shape —
   27/27 resolved against real output.
2. The first `isTrustedRequest` self-test asserted `*:5432` was "not local". That was the wrong
   *semantic*, not a code bug: `*` means "all interfaces", which for a port manager is the
   interesting case. The field is now two explicit booleans, `exposed` and `loopbackOnly`.

### Still explicitly unverified

1. **Runtime behaviour of live patch reload** for a package that is already installed but newly
   listed by an `insert` row in the profile's `cordis.patch.yml` (§5.5 item 2). Read from
   `composeLive`/`watchUserPatches`; not executed against a running server.
2. **Whether `dsh-client-hmr` actually swaps a hand-written bundle** in an open page without
   `pnpm run dev:web` (§5.5 item 3). The mtime-polling code path supports it; not observed in a
   browser.
3. **Whether macOS Seatbelt permits `lsof` to enumerate all listening sockets** when run through
   `ctx.shell` rather than directly (§3.3).
4. **`process.kill` on other users' processes** requires the DSH host to run as that user or as
   root; the code maps `EPERM` → 403 rather than escalating.
5. **The full install happy-path** (`dsh plugin --profile web add link:…` → restart → route live)
   was **not** executed, because it writes outside this session's workspace. Every write it makes
   is quoted from `lib/plugin-Ddi42qoW.js`; the fence, parsers, kill guardrails and both bundle
   halves were verified independently as above.
6. `parseLsof`'s exact column indices were verified against real macOS `lsof` output; other BSD
   variants (or a `lsof` whose `FD`/`TYPE`/`DEVICE`/`SIZE/OFF`/`NODE` set differs) may shift
   column 8. The parser reads `columns[8]` as NAME — pin `/usr/sbin/lsof` on macOS.
