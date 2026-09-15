# Native right-sidebar **page** tab for a third-party DSH client plugin — exact recipe

Target: DSH `0.1.5-rc.2`, installed at `/Users/youngi/.local/lib/node_modules/@deepseek-ai/dsh/`
(packages under `…/dsh/node_modules/@deepseek-ai/`).

Everything below is quoted from installed artifacts. Short paths are relative to
`/Users/youngi/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
(abbreviated `PKGS/`). Unverified items are flagged in **§8**.

**Verification status.** The recipe in §9 was written to
`dsh-PortManager/lib/client.js`, syntax-checked with `node --check`, and driven
through a harness that reproduces the real contracts (module-table `require`,
strict cordis service reflection, `ctx.effect` / `ctx.slots.inject` disposer
semantics, keyed-slot dispatch by type `id`): **25/25 assertions passed**,
including "the body renders the literal `hello`". It has **not** been loaded in
a live browser (see §8).

---

## 1. Client-plugin entry format

### 1.1 The bundle is a classic script that registers a factory

`PKGS/dsh-client-ui-sidebar-files/lib/client.js:1-4`:

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-sidebar-files",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
```

and the tail, `…/lib/client.js:714-716`:

```js
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
```

`PKGS/dsh-client-ui-sidebar-right/lib/client.js:3774-3776` is identical in shape.
Third-party bundles use exactly the same envelope — `dsh-screenshot/lib/client.js:10`
and `:858-860`; `skill-select/lib/client.js:19-21` and `:1184-1185`
(paths under `/Users/youngi/Documents/MiniWork/dsh插件/`).

`exports.inject` is a **plain array of cordis service names**; `exports.apply(ctx)`
is the plugin body. Nothing else is exported.

### 1.2 `id` must equal the package name (hard requirement)

`PKGS/dsh-client-modules/lib/types/client/manifest.d.ts`:

> `ClientBundleRegistration.id` — *"Plugin id (package name) — the registration
> key; must match the graph row being executed."*

Enforced at `PKGS/dsh-client-modules/lib/client.js:230-232` and `:248`:

```js
register(registration) {
    const id = stripClientSuffix(registration.id);
    if (this.bootstrapIds.has(id) || this.factories.has(id)) throw new Error(`client-modules: duplicate factory registration for "${registration.id}" (bundle executed twice without invalidate?)`);
    this.factories.set(id, registration.factory);
}
…
if (!this.factories.has(id)) throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`);
```

So `id` = npm package name = boot-graph row id. `stripClientSuffix` (`:61`) only
strips a trailing `/client`.

### 1.3 What `require()` can resolve

Two sources, and **only** these two.

**(a) The frozen platform seed table.** The shell builds the module system with
`staticModules` (`PKGS/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`, the
`by()` factory at byte ~553 100 of the single-line minified bundle):

```js
function by(){return{react:ec,"react/jsx-runtime":ic,"react-dom":cc,"react-dom/client":fc,
"@deepseek-ai/cordis":Ha,"@deepseek-ai/dsh-client-store":Hc,
"@deepseek-ai/dsh-client-ui-slots":Ac,"@deepseek-ai/dsh-client-ui-primitives":Zg,
"@deepseek-ai/dsh-client-ui-dockkit":Ey}}
```

Nine specifiers, exactly:

```
react · react/jsx-runtime · react-dom · react-dom/client
@deepseek-ai/cordis · @deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots · @deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

This matches the imports the shipped bundles actually make — the complete
`require()` set of `dsh-client-ui-sidebar-right/lib/client.js` is
`react`, `react-dom`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-dockkit`, `@deepseek-ai/dsh-client-ui-primitives`;
sidebar-files/docpreview use the same minus dockkit.

**(b) Other plugin bundles** — but only when the requesting package declares the
exact specifier in `dsh.client.external`, and the named row's factory has already
arrived. `PKGS/dsh-client-modules/lib/types/client/manifest.d.ts`:

> `external?: string[]` — *"Non-baseline module specifiers this row requests;
> omitted when it requests none."*

Resolution order, `PKGS/dsh-client-modules/lib/client.js:300-309`:

```js
makeRequire(edges) {
    return (spec) => {
        edges.add(spec);
        if (this.seed.has(spec)) return this.seed.get(spec);
        const id = stripClientSuffix(spec);
        const record = this.loadCache.get(id);
        if (record !== void 0) return record.exports;
        if (this.factories.has(id)) return this.materialize(id).exports;
        throw new Error(`client-modules: require("${spec}") missed the module table — …`);
    };
}
```

**Consequence for us:** `require("@deepseek-ai/dsh-client-ui-sidebar-right")`
is **not** resolvable for a third-party plugin unless it is declared in
`dsh.client.external` (and the row has arrived). The good news is that a tab type
**never needs to import that package**: all contract types are type-only, and the
runtime API arrives as a cordis *service* (`ctx.sidebarRightTabs`) — the same
path `dsh-client-ui-sidebar-files` takes (`…/lib/client.js:681-687` declares the
service, and never `require`s the package).

> Caveat worth knowing: `PKGS/dsh-client-ui-sidebar-documentpreview/lib/client.js:10998`
> contains `require("url")` inside a Node-only pdfjs `NodeCanvasFactory` branch.
> It is dead code in the browser, but it proves the failure mode: any reached
> `require()` outside the two sources above throws.

### 1.4 Minimal real example

`skill-select/lib/client.js:19-27` (a real, working third-party bundle):

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

…and `:1184-1185`: `exports.apply = apply; exports.inject = inject;`

---

## 2. Registering a native right-sidebar **page** tab type

Yes — `ctx.sidebarRightTabs.register({...})`.

### 2.1 Exact type definitions

`PKGS/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:43`:

```ts
export type SidebarRightTabPriority = 'extension' | 'builtin' | 'fallback';
```

`:45-62`:

```ts
export interface SidebarRightGuideEntry {
    /** Ascending position among every registered type's entries. */
    readonly order: number;
    /** The capsule's title. */
    readonly title: () => string;
    /** One line under the title … */
    readonly description?: () => string;
    /** Optional glyph, drawn before the title; without one the guide draws its cube placeholder. */
    readonly icon?: ComponentType<IconProps>;
}
export interface SidebarRightGuideBox extends SidebarRightGuideEntry {
    readonly kind: string;
}
```

`:68-109`:

```ts
export interface SidebarRightTabDefinition {
    readonly id: string;              // unique across every registration; body+title register under it
    readonly kind: string;            // type discriminator; what openTab names
    readonly patterns?: readonly string[];   // omit for a PAGE type
    readonly priority?: SidebarRightTabPriority;  // defaults to 'extension'
    readonly canOpen?: (address: string) => boolean;
    readonly title: (address: string) => string;  // captured into the layout record at open time
    readonly guide?: readonly SidebarRightGuideEntry[];
}
```

Register method, `:140-153`:

```ts
    register(definition: SidebarRightTabDefinition): () => void;
```

> *"Returns idempotent disposer. … @throws when the id is taken, or the kind is
> already registered in a way this one cannot coexist with."*

Key rules from `README.md` ("Extension seats"):

* *"A page type — the guide, a file tree — names none and is opened by kind."*
* *"A `kind` carries at most one `builtin` and one `extension` registration (the
  extension is in force; the builtin resumes when it leaves); any other collision
  on a kind throws."* → for a **brand-new page type** the `extension` band (also
  the default) is correct; nothing shadows anything.
* *"`title(address)` is the tab chip's text, captured when the tab opens."* For a
  page the address is `sidebar://<kind>` (`lib/client.js:248-250`:
  `` function pageAddress(kind) { return `sidebar://${kind}`; } ``), so the
  argument can be ignored.
* *"Thunked copy (`title`, `guide[].title`, `guide[].description`) is read again
  on every use, so a language change needs no re-registration."*

### 2.2 Shipped literals to copy

The guide type — `PKGS/dsh-client-ui-sidebar-right/lib/client.js:3574` and `:3584-3591`:

```js
const GUIDE_ID = "@deepseek-ai/dsh-client-ui-sidebar-right/guide";
function guideDefinition(t) {
    return {
        id: GUIDE_ID,
        kind: GUIDE_KIND,            // "guide"  (const GUIDE_KIND = "guide" at :240)
        priority: "builtin",
        title: () => t("tab.guide.title")
    };
}
```

The **page** type with a `guide` entry — `PKGS/dsh-client-ui-sidebar-files/lib/client.js:15-43`:

```js
const FILES_KIND = "files";
const FILES_ID = "@deepseek-ai/dsh-client-ui-sidebar-files";

function FolderSheetGlyph({ size, className }) {
    return jsx(FileTypeIcon, { kind: "folder", size, className });
}

function filesDefinition(t) {
    return {
        id: FILES_ID,
        kind: FILES_KIND,
        priority: "builtin",
        title: () => t("type.label"),
        guide: [{
            order: 10,
            title: () => t("guide.title"),
            description: () => t("guide.description"),
            icon: FolderSheetGlyph
        }]
    };
}
```

Registration site — `…/lib/client.js:694`:

```js
ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), "ui-sidebar-files: files type");
```

Third-party precedent (`dsh-notebook/lib/client.js:2137-2191`) uses
`kind` === `id` === `"dsh-notebook"`, `priority: "extension"`, and
`guide: [{ order: 60, title, description, icon }]`.

### 2.3 `guide` entry semantics (what the user sees)

`PKGS/dsh-client-ui-sidebar-right/lib/client.js:129-172`:

```js
function EntryBox({ entry, described, onPick }) {
    const Icon = entry.icon ?? CubeGlyph;
    const description = described ? entry.description?.() : void 0;
    return jsxs("button", { … "data-sidebar-right-guide-entry": entry.kind,
        onClick: () => { onPick(entry); },
        children: [ … jsx(Icon, { size: description === void 0 ? 22 : 26, … }), … entry.title(), … description ] });
}
function ShippedGuide({ entries, onPick }) { … entries.map((entry, index) => jsx(EntryBox, {
    entry, described: entries.length <= MAX_DESCRIBED_ENTRIES, onPick }, `${entry.kind}:${index}`)) }
```

* `icon` is a **React component** receiving `{ size, className }` (`IconProps`);
  omit it and the guide draws a quieter cube placeholder.
* `description` renders **only** while the guide lists few enough entries —
  `described: entries.length <= MAX_DESCRIBED_ENTRIES` (`lib/client.js:168`),
  where `const MAX_DESCRIBED_ENTRIES = 4;` (`lib/client.js:127`).
* Entries are globally ordered by `order` ascending.
* Picking a capsule calls `tab.actions.openTab(entry.kind, { replaceTab: true })`
  (`lib/client.js:181`).

`canOpen` is irrelevant for a page type (it only vetoes glob matches);
`patterns` must be **omitted**, not empty-array-guessed — every page type in the
tree omits it.

### 2.4 What `kind` to use for a brand-new page type

Any string not already held. Fresh names in the tree: `"guide"` (builtin),
`"files"` (builtin), `"text"` (fallback, documentpreview), `"dsh-notebook"`
(extension). Since a kind admits one `builtin` + one `extension`, picking a new
string such as `"port-manager"` cannot collide. Keep `id` distinct from `kind`
is allowed but not required; `dsh-notebook` uses one string for both.

---

## 3. Registering the tab **BODY**

### 3.1 Exact slot name and call

Slot name string: **`"sidebar.right.pane.tab"`** (keyed, session scope).

`PKGS/dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts:19-31`:

```ts
        'sidebar.right.pane.tab': {
            kind: 'keyed';
            scope: 'session';
            hookContext: TabHookContext;
            inject: SidebarRightTabInjected;
        };
```

Real call — `PKGS/dsh-client-ui-sidebar-files/lib/client.js:699-707`:

```js
const store = createFilesStore();
const inject = filesFace(createList(ctx.remote));
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: FILES_ID,
    locale: NS,
    store,
    inject
}, FilesBody)), "ui-sidebar-files: files tab body");
```

`key` **is the type's `id`** — the seat dispatches a tab to the entry keyed by the
`id` of the type in force for its `kind` (`README.md`: *"The `id` is also the key
the type's body and title register under"*). `locale`/`store`/`inject` are all
optional extras; the minimal form is `{ name, key }` (see the shipped slot
catalog example, `PKGS/dsh-cordis-client-runner/lib/client.js:4200`:

```
{ name: 'sidebar.right.pane.tab', key: '<one key the owner dispatches>' }
```

).

### 3.2 What props the component receives

`useTabInfo()` is **framework-injected**, not supplied by the registrant. The
slot owner (sidebar-right) declares the child inject at
`lib/client.js:3716-3721`:

```js
children: {
    "sidebar.right.pane.tab": {
        kind: "keyed",
        scope: "session",
        inject: { hooks: { tabInfo: tabInfoFactory } }
    },
```

which materialises as the `useTabInfo` prop on every occupant
(`slots.d.ts:140-145`):

```ts
export interface SidebarRightTabInjected {
    hooks: {
        tabInfo: SlotHookFactory<'sidebar.right.pane.tab', UseSidebarRightTabInfo>;
    };
}
```

`slots.d.ts:117-139` gives the returned shape exactly:

```ts
export interface SidebarRightTabInfo {
    readonly sidebar: {
        readonly expanded: boolean;
        readonly fullscreen: boolean;
    };
    readonly panel: { readonly id: PaneId };
    readonly tab: TabRecord & {
        readonly visible: boolean;
        readonly navigation: SidebarRightTabNavigation;   // { address, params, revision }
        readonly signal: AbortSignal;
        readonly actions: SidebarRightTabActions;
    };
}
export type UseSidebarRightTabInfo = () => SidebarRightTabInfo;
```

`slots.d.ts:96-115` — the actions a body gets:

```ts
export interface SidebarRightTabActions {
    openResource(address: string, options?: SidebarRightTabPlacement & {
        readonly params?: SidebarRightResourceParams;
    }): void;
    openTab<K extends string>(kind: K, options?: SidebarRightTabPlacement & {
        readonly params?: SidebarRightTabParamsFor<K>;
    }): void;
    close(): void;
}
```

`TabHookContext` (the non-prop half) — `lib/types/client/tab-info.d.ts:6-14`:

```ts
export interface TabHookContext {
    readonly tabId: TabId; readonly title: boolean; readonly fullscreen: boolean;
    readonly signal: AbortSignal; readonly actions: SidebarRightTabActions;
    readonly useStore: …; readonly useTabNavigation: …;
}
```

`tab.actions` are session-bound (`service.d.ts:14-17`): *"they run through that
session's adopted store, so a callback fired after the user switched sessions
still lands where its tab is."*

The shipped body shows the destructuring convention —
`PKGS/dsh-client-ui-sidebar-files/lib/client.js:418-421`:

```js
function FilesBody({ useTabInfo, sessionId, useSessions, useStore, actions, start, load, toggle, t }) {
    const { tab } = useTabInfo();
    const { signal, actions: tabActions } = tab;
```

and it opens files with `tabActions.openResource(fileAddressFor(sessionId, state.root, path))`
(`:451`). The implementation of the hook is `lib/client.js:3601-3635`; note it
**throws** if the tab record is not committed:

```js
if (layout === void 0 || tab === void 0 || navigation === void 0) throw new Error(`sidebarRight: tab "${tabId}" is not committed in session "${sessionId}"`);
```

Additional standard props are available to any slot occupant (`sessionId`,
`useSessions`, `useStore`, `usePanelInfo`, `useResource`, …) per the generated
slot catalog at `PKGS/dsh-cordis-client-runner/lib/client.js:4160-4201`
(`standardProps` block at `:4175-4188`).

Optional: a live chip title registers at `"sidebar.right.pane.tab.title"` under
the same `key` (`sidebar-files/lib/client.js:708-711`; component at `:510-517`).
Without it the chip shows the `title(address)` text captured at open.

---

## 4. Opening the tab

### 4.1 API

`PKGS/dsh-client-ui-sidebar-right/lib/types/client/service.d.ts:104-125`:

```ts
export interface ISidebarRight {
    openResource(address: string, options?: SidebarRightOpenResourceOptions): void;
    openTab<K extends string>(kind: K, options?: SidebarRightOpenTabOptions<K>): void;
    close(tabId: TabId): void;
    active(): TabRecord | undefined;
    isExpanded(): boolean;
    toggleExpanded(): void;
    focus(tabId: TabId): void;
    split(paneId?: PaneId): PaneId | undefined;
    float(tabId: TabId, rect?: FloatRect): void;
    dock(paneId: PaneId): void;
}
```

Page options — `:100-103`:

```ts
export interface SidebarRightOpenTabOptions<K extends string = string> extends SidebarRightPlacement {
    readonly params?: SidebarRightTabParamsFor<K>;
}
```

`SidebarRightPlacement` (`:81-91`): `{ paneId?, replaceTab?, revealIfOpened? }`.
From a tab body the equivalent is `tab.actions.openTab(kind, { replaceTab: true })`.

### 4.2 Where `ctx.sidebarRight` comes from

Both services are provided by the sidebar-right plugin inside one effect —
`PKGS/dsh-client-ui-sidebar-right/lib/client.js:3667-3673`:

```js
const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);
const disposeService = ctx.reflect.provide("sidebarRight", controller);
ctx.effect(() => () => {
    controller.tabDomain.dispose();
    disposeService();
    disposeRegistry();
}, "ui-sidebar-right: service faces");
```

Consumers reach it as a cordis service, so **yes, it needs an `inject` entry** in
the bundle's `exports.inject` (a bare `ctx.sidebarRight` read on an undeclared
service throws — see the comment in
`dsh-screenshot/lib/client.js:805-807`: *"未声明就裸访问服务属性在 DSH 0.1.5 会抛
`cannot get property \"sessions\" without inject`"*). Plugins that must survive
without the sidebar package use `ctx.inject(["sidebarRightTabs"], injected => …)`
instead — `dsh-notebook/lib/client.js:2176-2191`, and the installed
`dsh-better-sidebar@0.19.1` at `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/client.js:16997-16999`.

For a plugin that is *always* paired with the native sidebar, declaring
`"sidebarRightTabs"` in `exports.inject` is the simpler and correct choice. Only
declare `"sidebarRight"` if you actually call `openTab` imperatively.

### 4.3 When it is available; what happens with no surface

The controller is a **root-scoped** service, but every command routes through the
*mounted* seat's binding. `PKGS/dsh-client-ui-sidebar-right/lib/client.js:1414-1417`:

```js
require() {
    if (this.binding === void 0) throw new Error("sidebarRight: no session surface is mounted");
    return this.binding;
}
```

and `openTab` (`:1231-1234`) calls `this.require()` first. `README.md`:

> *"Commands need a mounted session surface; with none, they throw rather than
> write into a surface nobody draws."*

The seat binds while mounted, regardless of collapsed/expanded —
`lib/client.js:973-979` binds in a plain `useEffect`, and
`:1013-1014` gates the whole subtree:

```js
function RightbarRoot({ usePanelInfo, SessionProvider, renderSlot, width, viewportWidth, canShow }) {
    if (!usePanelInfo((info) => info.activePanelId === null)) return null;
```

So: **the tab can only be opened from within a mounted session, while the
Conversation (not a global left-sidebar panel) is selected.** No session / hero
screen → no surface → `openTab` throws.

Practical consequence: open the tab from the **guide capsule**
(`tab.actions.openTab(entry.kind, { replaceTab: true })`), which is already inside
a mounted tab — that path needs no `sidebarRight` service at all. If you must call
it imperatively (e.g. a header button), wrap in try/catch, exactly as
`dsh-notebook/lib/client.js:2198-2209` does.

---

## 5. Locales

### 5.1 Registration

`ctx.locale` is provided by `@deepseek-ai/dsh-client-locale`. Two overloads,
`PKGS/dsh-client-locale/lib/types/client/index.d.ts:188` and `:198`:

```ts
register<N extends Extract<keyof LocaleNamespaceMap, string>>(ns: N, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>): () => void;
register(ns: string, locale: string, dict: LocaleDict): () => void;
```

plus `:215`: `bind(ns: string): Translate;`

`LocaleDict` = `Record<string, string>` with `{name}` placeholders
(`…/index.d.ts`, "Locale dictionary: flat key to template string").

Shipped pattern — `PKGS/dsh-client-ui-sidebar-files/lib/client.js:676`, `:693`,
`:695-698`:

```js
const NS = "sidebarFiles";
…
const t = ctx.locale.bind(NS);
ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-sidebar-files: dictionaries");
```

(`zh`/`en` are literal objects at `:521-551`; note `NS` is *not* in the typed
`LocaleNamespaceMap`, yet the `{zh,en}` overload compiles in the source because
the package augments the map — for a third-party plugin use the 3-arg overload.)

Third-party pattern (`dsh-notebook/lib/client.js:175-185`):

```js
for (const [lang, dict] of [["zh", zh], ["en", en]]) try {
    const dispose = locale.register(LOCALE_NS, lang, dict);
    if (typeof dispose === "function") detach.push(dispose);
} catch {}
```

### 5.2 Can a plugin skip localization? **Yes.**

Neither `skill-select/lib/client.js` nor `dsh-screenshot/lib/client.js` registers a
locale namespace at all — `grep -n "locale"` over both files returns no
`ctx.locale` usage (only `String.prototype.localeCompare`). Their `inject` arrays
are `["conversation"]` and `["slots","connection","remote","settingsScope","sessions"]`
respectively, with no `"locale"` entry. All their user-visible text is hard-coded.

**No registration is needed to avoid a runtime error.** The only copy the
sidebar-right package owns is its own chrome, served from its own `sidebarRight`
namespace; a tab type's `title`/`guide[].title`/`guide[].description` are the
plugin's own thunks and may return plain strings. The reference
`dsh-PortManager/lib/client.js` in §9 does exactly this and passes the harness.

---

## 6. Making the entry point clickable

### (a) A `guide` entry registered by a third-party page type — **the native way**

`guide` is the mechanism the tab registry itself defines for *"entry boxes for the
guide page; picking one opens the contributing type as a page"*
(`README.md`, "Extension seats"). The shipped **Files** tab uses exactly this:

* `sidebar-files/README.md`: *"The type — `ctx.sidebarRightTabs.register(...)` with
  kind `files`, id `@deepseek-ai/dsh-client-ui-sidebar-files`, band `builtin`, no
  patterns, and **one guide entry (order 10, its title and description from the
  `sidebarFiles` namespace, its glyph the shared folder icon) that opens the
  type**."*
* Registered at `lib/client.js:694`; the definition at `:29-43` quoted in §2.2.

What the user does / sees, concretely:

1. Opens the right column with the **expand button** in the conversation
   header's corner seat (`README.md`, "The expand button": *"one button in the
   conversation header's corner seat … is the way back in"*; implementation
   `lib/client.js:204-221`, `data-sidebar-right-expand`).
2. The pane's default page depends on how many guide entries exist —
   `PKGS/dsh-client-ui-sidebar-right/lib/client.js:229-234`:

   ```js
   function defaultSeed(tabs) {
       const [only, ...others] = tabs.guide();
       const kind = only !== void 0 && others.length === 0 ? only.kind : GUIDE_KIND;
       …
   }
   ```

   **In the shipped composition `Files` contributes exactly one entry, so the
   default page is the Files tree itself.** Adding Port Manager makes it *two*
   entries, which flips the default page to the **guide**, showing two capsules:
   "Workspace files" and "Port Manager" (with descriptions, since 2 ≤ 4).
   *(`README.md`: "Exactly one entry opens its page directly (Files in the shipped
   composition); zero or multiple entries open the guide.")*
3. Clicking the **Port Manager** capsule calls
   `tab.actions.openTab("port-manager", { replaceTab: true })` (`lib/client.js:181`)
   — the tab opens in that pane and expands the column.
4. The strip's **add** control (`+`) reopens the guide at any time while the pane
   holds none: `openTab('guide', { paneId, revealIfOpened: false })` (`README.md`,
   "The guide").

> Note: this machine's composition (`~/.dsh/profiles/web/package.json` bundles
> `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `dsh-better-sidebar`,
> `api-balance`, `dsh-skill-select`, `dshmarket`, `dsh-screenshot`,
> `dsh-work-scope`, `dsh-notebook`) enables `ui-sidebar-files` and
> `ui-sidebar-documentpreview` via `PKGS/dsh-web-app/cordis.patch.yml:220-236`.
> The installed `dsh-better-sidebar@0.19.1` also claims the native seat and
> registers guide entries for its own descriptors — so the live guide may show
> **more** capsules than the two above.

### (b) The left-sidebar `sidebar.panellist` seat — **a different surface**

`PKGS/dsh-client-ui-sidebar/README.md:36`:

> *"Plugins add an icon component to the root-scoped `sidebar.panellist` list with
> an `id`, optional `order`, and a string or locale-aware `label`. The same id
> addresses the component registered in the layout's root-scoped `main` keyed
> slot; selecting a missing main entry throws without changing the current
> selection. The label supplies plain visible text, the accessible name, and the
> collapsed tooltip. … With no registrations, neither the list nor spacing for it
> is rendered."*

Contract — `PKGS/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:35-45`:

```ts
        'sidebar.panellist': {
            kind: 'list';
            scope: 'root';
            owner: SidebarPanelIconOwnerProps;
        };
```

`:87-95`:

```ts
export interface SidebarPanelIconOwnerProps {
    /** Requested square edge in pixels. */
    size: number;
    /** Whether this panel is selected in the main column. */
    active: boolean;
}
```

The body goes in the layout's root-scoped keyed `main` slot —
`PKGS/dsh-client-ui-layout/lib/types/client/index.d.ts:44-52`:

```ts
        /**
         * Central panel selected by sidebar entry id. The reserved `conversation`
         * key hosts the Conversation; other keys receive no Session binding.
         */
        'main': { kind: 'keyed'; scope: 'root' };
```

Selection plumbing: `ui-sidebar` maps list entries to metadata and calls
`ctx.layout.selectPanel(id)` (`PKGS/dsh-client-ui-sidebar/lib/client.js:346-361`
and `:365-372`). The shipped `README.md` notes *"The shipped composition
registers no example panel."* — the only in-tree registrant is the Cordis dev
console (`PKGS/dsh-cordis-client-runner`, catalog entry at `:4116-4159` with its
example at `:4157`; the `main` seat's entry at `:3372-3400`, example `:3399`),
whose generated example is:

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'my-entry', order: 100, label: 'My entry' },
  () => React.createElement('div', null, 'hello'),
))
```

**This is NOT the right-sidebar tab system.** It replaces/occupies the *centre*
panel and, while a global panel is active, `RightbarRoot` returns `null`
(`sidebar-right/lib/client.js:1013-1014`) — i.e. the native right sidebar
unmounts and `ctx.sidebarRight.*` starts throwing. It is the correct seat for a
full central workbench (that is how `dsh-better-sidebar`-style products and the
Cordis console present themselves), **not** for a right-sidebar tab.

### Which is the native way?

**The `guide` entry (`ctx.sidebarRightTabs.register({ …, guide: [...] })`) is the
native, named, clickable entry that opens a custom panel in the right sidebar.**
`sidebar.panellist` is a separate seat for a *global main-column* panel.

**Can both be done from the same plugin?** Yes — they are independent root-scoped
seats with no shared key space, and one `apply(ctx)` may register both (that is
exactly what `dsh-better-sidebar`'s native adapter plus a panel product would do).
But for "open the sidebar and click Port Manager", only the guide entry is needed.

---

## 7. `package.json` fields required for the client half to load

### 7.1 The minimum

1. **A host half must exist.** The client module system discovers `dsh.client` by
   scanning **host Loader entries**: *"the host half scans enabled Loader entries
   and composes the boot graph"* (`PKGS/dsh-client-modules/README.md`). So the
   package must be mountable as a cordis row with a resolvable
   `main`. `PKGS/dsh-client-ui-sidebar-right/lib/index.js` is literally
   `function apply() {}` / `export { apply };`.
2. `dsh.client.platform` must be the string `"web"` —
   `PKGS/dsh-client-modules/lib/index.js:650-654`:
   ```js
   const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
   if (decl === void 0 || decl.platform !== "web") { this.pkgMeta.set(sourceKey, null); return null; }
   ```
   (`parseDshClient` at `:139-152` throws if `platform` is not a string.)
3. `exports["./client"]` must resolve to a string or `{default: string}` —
   `:655-656` and `clientExportOf` at `:156-166`:
   ```js
   if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
   ```

### 7.2 `dsh.client.inject` — informational, **not** cordis service injection

`PKGS/dsh-package-manifest/lib/types/types.d.ts:38-52`:

```ts
export interface DshClientManifest {
    /** Client platform identifier; the Web consumer selects `web`. */
    platform: string;
    /** Informational package-name dependencies, not Cordis service injection. */
    inject?: string[];
    /** Boot phase-one registration barrier; absent means the shared application batch. */
    immediately?: boolean;
    /**
     * Exact module-table requests beyond the implicit client baseline, including
     * subpaths such as `<pkg>/client`; absent means baseline externals only.
     * Type-only imports are erased and create no module request.
     */
    external?: string[];
}
```

Consumed at `PKGS/dsh-client-modules/lib/client.js:265-268` (factory arrival
before the consumer's own bundle) and mirrored onto the boot rows
(`manifest.d.ts`: *"`inject` names package rows whose factories must arrive before
this row materializes"*).

**So: `dsh.client.inject` orders bundles; `exports.inject` (inside `lib/client.js`)
is what actually grants `ctx.slots` / `ctx.sidebarRightTabs` / `ctx.sidebarRight`.**
A plugin that only uses those services needs **no `external` at all**.

### 7.3 Comparison with the working third-party plugins

| package | `dsh.client.platform` | `dsh.client.inject` | `dsh.client.external` | `exports.inject` (in `lib/client.js`) | `./client` export |
|---|---|---|---|---|---|
| `dsh-skill-select` (`skill-select/package.json`) | `web` | `["@deepseek-ai/dsh-client-ui-conversation"]` | *(absent)* | `["conversation"]` (`lib/client.js:1136`) | `"./client": "./lib/client.js"` |
| `dsh-screenshot` (`dsh-screenshot/package.json`) | `web` | `["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-api-remotes"]` | *(absent)* | `["slots","connection","remote","settingsScope","sessions"]` (`lib/client.js:807`) | `"./client": "./lib/client.js"` |
| `@deepseek-ai/dsh-client-ui-sidebar-files` | `web` | `["@deepseek-ai/dsh-api-workspace-files","@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-ui-session","@deepseek-ai/dsh-api-remotes"]` | *(absent)* | `["slots","locale","sidebarRightTabs","remote","remote.workspaceFiles"]` (`lib/client.js:681-687`) | object form with `types`/`default` |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | `web` | `["@deepseek-ai/dsh-api-gateway","@deepseek-ai/dsh-api-workspace-files","@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-ui-session","@deepseek-ai/dsh-api-remotes"]` | *(absent)* | *(n/a)* | object form |

Two facts to carry over:

* Both shipped sidebar tab users list **`@deepseek-ai/dsh-client-ui-sidebar-right`
  in `dsh.client.inject`** — follow that for ordering/documentation.
* **None of them declare `external`**, because none of them `require()`s the
  package. Do the same.

### 7.4 Mounting

The package must be an enabled loader row. Third-party convention (skill-select,
screenshot) is a `cordis.patch.yml` at the package root plus
`dsh.bundle.patch`:

```yaml
- insert:
    - id: port-manager
      name: 'dsh-port-manager'
```

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`dsh.plugin.json` (`{ id, version, main, client: { main } }`) is shipped by both
third-party plugins — **flagging as unverified**: `grep -rln "plugin.json"` over
`PKGS/**` finds no reader in the installed DSH packages, so it appears to be
consumed by external tooling (marketplace / plugin CLI) rather than by
`dsh-client-modules`. It is harmless to include.

---

## 8. Not verified / caveats

* **No live browser run.** The bundle was verified by a contract-reproducing Node
  harness (§9.4), not by the running GUI at `http://127.0.0.1:3080`. Loading it
  live requires installing the package into `~/.dsh/profiles/web/` and restarting
  the web server — outside the scope of this research task.
* **The platform seed list** was read from the *built* shell bundle
  (`dsh-web-frontend@0.1.5-rc.2`, `dist/assets/index-BKQ_L1z6.js`, minified). No
  un-minified source ships in this installation (`…/dsh/` contains only `lib/`).
  The list is corroborated by the `require()` sets of the shipped client bundles,
  which never exceed it.
* **`IconProps`** is imported from `@deepseek-ai/dsh-client-ui-primitives`
  (`tab-registry.d.ts:29`), but that package is **not installed as a readable
  directory** (it lives only in the shell's seed table). The `{ size, className }`
  shape is inferred from two real call sites — `sidebar-files/lib/client.js:19-24`
  (`FolderSheetGlyph({ size, className })`) and installed
  `dsh-better-sidebar/lib/client.js` (`guideIconOf`: `icon: (props) => icon(props.size ?? 16)`).
* **`ctx.slots.register` / `ctx.slots.inject` / `ctx.effect` type signatures** were
  not read from `.d.ts` (the `dsh-client-ui-slots` package is likewise not
  installed on disk). Their behaviour is documented in the slots package's README
  quotes, in the generated slot catalog
  (`dsh-cordis-client-runner/lib/client.js:2233` etc., all examples using
  `ctx.slots.inject(name, () => ctx.slots.register({name, …}, C))`), and in the
  shipped registrations quoted above.
* **`MAX_DESCRIBED_ENTRIES`** has been confirmed as the literal `4`
  (`PKGS/dsh-client-ui-sidebar-right/lib/client.js:127`); descriptions are
  suppressed once the guide lists five or more entries.
* **`ctx.effect`'s exact error behaviour on a non-function return** was not
  inspected; every shipped call returns a disposer.
* Live guide contents on this machine will include **better-sidebar 0.19.1**'s own
  descriptors, so expect more capsules than just Files + Port Manager.

---

## 9. The deliverable

### 9.1 `lib/client.js` (complete, plain JS, no build step)

Written to `dsh-PortManager/lib/client.js`:

```js
/**
 * dsh-port-manager — client half (web ModuleLoader bundle).
 *
 * Registers a NATIVE right-sidebar PAGE tab ("page type": no `patterns`, opened
 * by `kind`) into `@deepseek-ai/dsh-client-ui-sidebar-right`, plus the keyed
 * body slot that renders it. Plain JS, no build step.
 *
 * Runtime host: `window.__ModuleLoader__` (module id === package name === boot
 * graph row id). `require()` resolves only through the module table:
 *   - platform seed words: "react", "react/jsx-runtime", "react-dom",
 *     "react-dom/client", "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store",
 *     "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives",
 *     "@deepseek-ai/dsh-client-ui-dockkit"
 *   - other registered plugin bundles, but only when declared in
 *     `dsh.client.external`
 * Anything else throws "missed the module table". This bundle needs `react` only.
 *
 * Two-phase registration, both owned by `ctx.effect` (so HMR/unload is clean):
 *   1. the TYPE  -> ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })
 *   2. the BODY  -> ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)
 * `key` is the type's `id`, because the seat dispatches a tab to the entry keyed
 * by the `id` of the type in force for its `kind`.
 */
window.__ModuleLoader__.load({
  id: "dsh-port-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    /** This implementation's identity in the tab system AND the key its body registers under. */
    const PORT_MANAGER_ID = "dsh-port-manager";
    /** The page type discriminator. `ctx.sidebarRight.openTab("port-manager")` names it. */
    const PORT_MANAGER_KIND = "port-manager";

    /** Guide capsule glyph. Optional: without one the guide draws its cube placeholder. */
    function PortManagerGlyph({ size = 16, className }) {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          className,
          "aria-hidden": true,
          fill: "none",
          style: { display: "block", flexShrink: 0 },
        },
        React.createElement("rect", {
          x: 1.5, y: 3.5, width: 13, height: 9, rx: 2,
          stroke: "currentColor", strokeWidth: 1.2,
        }),
        React.createElement("circle", { cx: 4.5, cy: 6.6, r: 1, fill: "currentColor" }),
        React.createElement("circle", { cx: 7.5, cy: 6.6, r: 1, fill: "currentColor" }),
        React.createElement("circle", { cx: 10.5, cy: 6.6, r: 1, fill: "currentColor" }),
        React.createElement("path", {
          d: "M4 10.4h8", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round",
        }),
      );
    }

    /**
     * The tab body. `useTabInfo` is framework-injected by the slot owner
     * (`SidebarRightTabInjected.hooks.tabInfo`), not supplied by this plugin.
     * It returns `{ sidebar: { expanded, fullscreen }, panel: { id }, tab }`,
     * where `tab` carries the record, `visible`, `navigation`, `signal` and
     * `actions` (`openResource` / `openTab` / `close`).
     */
    function PortManagerBody(props) {
      const info = props.useTabInfo();
      const { tab } = info;
      return React.createElement(
        "div",
        {
          "data-port-manager-tab": tab.id,
          style: {
            display: "flex", flexDirection: "column", gap: 8,
            height: "100%", minHeight: 0, padding: 16,
            color: "var(--dsw-alias-label-primary, #e8eaf0)",
            fontFamily: "inherit", fontSize: 13,
          },
        },
        React.createElement("div", { style: { fontSize: 15, fontWeight: 600 } }, "Port Manager"),
        React.createElement("div", null, "hello"),
      );
    }

    /**
     * Cordis services this plugin reads through `ctx.<name>`.
     * `slots` is always available; `sidebarRightTabs` is provided by
     * `@deepseek-ai/dsh-client-ui-sidebar-right` and gates activation on it.
     * (Deliberately NOT `sidebarRight` — a page type that only opens from the
     * guide needs no navigation controller, and requiring it would make the
     * plugin inert whenever no session surface is mounted.)
     */
    const inject = ["slots", "sidebarRightTabs"];

    /**
     * Plugin body.
     * @param ctx - the client root context carrying the slot registry and the tab-type registry.
     */
    function apply(ctx) {
      // Stage 1 — the type. Identical public path the shipped guide and
      // ui-sidebar-files use; `ui-sidebar-documentpreview` is the pristine proof.
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: PORT_MANAGER_ID,
            kind: PORT_MANAGER_KIND,
            // A page type names no `patterns` and recognizes no address.
            priority: "extension",
            // The chip text, captured into the layout record at open time.
            // Plain string: no locale namespace needed for a custom plugin.
            title: () => "Port Manager",
            // One entry capsule on the guide page. Picking it calls
            // tab.actions.openTab(entry.kind, { replaceTab: true }).
            guide: [
              {
                order: 20,
                title: () => "Port Manager",
                description: () => "Inspect and manage listening ports",
                icon: PortManagerGlyph,
              },
            ],
          }),
        "dsh-port-manager: page tab type",
      );

      // Stage 2 — the body, keyed by the type's `id`.
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register(
              { name: "sidebar.right.pane.tab", key: PORT_MANAGER_ID },
              PortManagerBody,
            ),
          ),
        "dsh-port-manager: page tab body",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
```

### 9.2 `package.json` (complete, not just the fragment)

Written to `dsh-PortManager/package.json`. **The `name` must equal both the
`__ModuleLoader__.load({ id })` value and the loader row id.**

```json
{
  "name": "dsh-port-manager",
  "version": "0.1.0",
  "description": "DSH web plugin: a native right-sidebar page tab that lists and manages listening ports.",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/client.js", "cordis.patch.yml", "dsh.plugin.json", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "react": "^18.2.0"
  }
}
```

### 9.3 `lib/index.js` — required empty host half

Written to `dsh-PortManager/lib/index.js` as an explicitly-labelled
**placeholder** (the real host half — route, `lsof`, `process.kill` — belongs
there and is out of scope for this report):

```js
export function apply() {}
```

Without it the package cannot be an enabled loader row, so `dsh-client-modules`
never scans its `dsh.client` declaration and the browser bundle is never served.
`PKGS/dsh-client-ui-sidebar-right/lib/index.js` is exactly this (a comment plus
`function apply() {}` / `export { apply };`).

Plus `cordis.patch.yml`:

```yaml
- insert:
    - id: port-manager
      name: 'dsh-port-manager'
```

⚠️ **Coordination note.** `package.json`, `cordis.patch.yml` and `lib/index.js`
are shared with the plugin's host half. The host half must keep
`exports["./client"]`, `dsh.client.platform: "web"` and `main` pointing at
`lib/index.js`, and must not rename the package — the name is also the
`__ModuleLoader__.load({ id })` value and the loader row id.

### 9.4 How it was verified

`node --check lib/client.js` (syntax) and a 25-assertion harness that reproduces
the real contracts — module-table `require`, `id === package name`, strict
service reflection, `ctx.effect` / `ctx.slots.inject` disposers, keyed dispatch by
type `id`, and `defaultSeed` arithmetic. Result:

```
ALL CHECKS PASSED
  … body renders the literal "hello" — ["Port Manager","hello"]
  … with Files (1) + Port Manager (1) entries the default page is the GUIDE — entries=2 -> default=guide
```

---

## 10. One-paragraph answer

A DSH client plugin is a classic `<script>` bundle that calls
`window.__ModuleLoader__.load({ id: <npm package name>, factory: require => { …; exports.apply; exports.inject; return module.exports } })`;
inside, `require()` resolves only the nine platform seed words (plus declared
`dsh.client.external` rows), so it imports `react` and nothing else. The plugin
declares `exports.inject = ["slots", "sidebarRightTabs"]`, then in `apply(ctx)`
does two `ctx.effect`-owned registrations: stage one
`ctx.sidebarRightTabs.register({ id, kind, priority: "extension", title: () => "Port Manager", guide: [{ order, title, description, icon }] })`
— **omit `patterns`**, that absence is what makes it a page type opened by kind —
and stage two
`ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: id }, Body))`,
where `Body({ useTabInfo })` reads `tab.actions` from the framework-injected hook.
The user opens the right column from the conversation header's expand button and
clicks the **Port Manager** capsule in the guide, which calls
`tab.actions.openTab(kind, { replaceTab: true })`; no locale registration is
required, and no imperative `ctx.sidebarRight.openTab` call is needed (that face
throws `"sidebarRight: no session surface is mounted"` without a mounted session).
