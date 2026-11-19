# STicks

A recreation of [x8rr/sapphire](https://github.com/x8rr/sapphire) for the
[STomp](https://github.com/Fracital/powerMouse) proxy engine (`@sysce/stomp`).

Sapphire is a Scramjet plugin that emulates the `chrome.*` extension APIs so
Chrome extensions run against proxied sites. STicks does the same job for
STomp. It was written from scratch around STomp's own extension points and
shares no code with Sapphire. Like Sapphire, it is a library: the host app
builds the toolbar, popups and extension manager on top of it.

## How it works

- **Installing.** `.crx` (v2 and v3) and `.zip` packages are read in the
  browser with no dependencies: a small ZIP reader plus `DecompressionStream`.
  The extension id comes from `manifest.key`, the CRX3 header or the CRX2
  key, so a Web Store download keeps its real id. Files go to Cache Storage;
  metadata and `chrome.storage` go to IndexedDB.
- **Extension pages** (popups, options, background pages, offscreen
  documents) are served by STicks' own service worker at `/sticks/ext/<id>/…`,
  on the host's origin. Its scope is separate from STomp's. The worker puts
  `page.js` first in every page, and `page.js` asks the host page for that
  page's `chrome` object before any extension script runs. An MV3
  `background.service_worker` runs in a hidden page with service-worker shims
  (`importScripts`, `registration`, `clients`, `skipWaiting`, and the
  install/activate events).
- **Content scripts** ride on STomp's `init.hooks`. The post hook runs in every
  proxied document before its first script and hands the real window to
  STicks. STicks matches `content_scripts` and `scripting` registrations
  against the page's real URL. It runs them through the page realm's own
  `Function` constructor, which STomp has already wrapped, so they are
  rewritten like any page script. `chrome` is passed in as a parameter, so
  page scripts never see it. `run_at`, `all_frames`, CSS and `world: 'MAIN'`
  are honored.
- **declarativeNetRequest** is compiled into STomp `RequestRule`s and applied
  with `controller.setRules()`. Both use URLPatterns, so domain lists, `||host^`
  filters and resource types translate directly. See *Limits* for what doesn't.
- **Network access** from extension pages (`fetch`) and Web Store downloads
  go through the proxy transport, so they get no CORS and the proxy's IP.
- **Cookies** use STomp's cookie jar (`controller.cookies`).

## Setup

Serve `static/` (its path is exported as `sticksPath` from `sticks/path`) at
`/sticks/`, the same way STomp's `dist/` is served at `/stomp/`. STicks needs
the same-origin `StompController`. The isolated `RemoteController` keeps
proxied pages out of the host's reach by design, so content scripts can't
be handed over.

```js
import EpoxyTransport from '@mercuryworkshop/epoxy-transport'
import { StompController } from '@sysce/stomp'
import { Sticks } from 'sticks'

const transport = new EpoxyTransport({ wisp: 'wss://example.com/wisp/' })
const sticks = new Sticks({ host, transport }) // host: your tab bindings, below

const registration = await StompController.register('/stomp/')
const controller = new StompController({
  serviceworker: registration,
  transport,
  directory: '/stomp/',
  hooks: Sticks.hooks(), // content scripts
  onRequest: sticks.onRequest, // chrome.webRequest events
  onNavigate: (info, frame) => sticks.navigated(tabIdOf(frame), info), // tabs.onUpdated
})
await controller.wait()
sticks.attach(controller) // rules and cookies
await sticks.ready() // registers /sticks/sw.js, loads installed extensions

await sticks.installFromWebStore('ddkjiahejlhfcafbddmgiahcphecmpfh') // uBlock Origin Lite
await sticks.install(await file.arrayBuffer(), file.name) // from a file picker
```

### Host bindings

STicks asks the browser UI about tabs through `host`. Only the first four are
required; each optional one makes the matching `chrome.*` call do something.

| Binding | Used for |
| --- | --- |
| `getTabId(frameWindow)` | which tab a STomp frame's window (or an extension page) belongs to |
| `getTab(id)`, `getTabs()`, `getActiveTabId()` | `tabs.query/get`, `sender.tab` |
| `createTab(url, { active, openerTabId })` | `tabs.create`, `windows.create`, `openOptionsPage` |
| `navigateTab`, `closeTab`, `reloadTab`, `activateTab`, `goBack`, `goForward` | `tabs.update/remove/reload/goBack/goForward` |
| `openPopup(extId, tabId)`, `closePopup(extId)` | toolbar clicks, `action.openPopup`, `window.close()` in a popup |
| `showNotification`, `clearNotification` | `chrome.notifications` |

Tell STicks what happens to tabs: `tabCreated(id)`, `tabActivated(id)`,
`tabRemoved(id)`, `tabUpdated(id, change)` (or `navigated(id, info)` from
STomp's `onNavigate`).

### Toolbar and popups

- `sticks.list(tabId)` gives each extension's name, icon URL, title, badge,
  popup and options URL. `sticks.onChange(cb)` fires when any of it changes.
- On a toolbar click call `sticks.clickAction(id, tabId)`. If the extension
  has a popup, STicks calls `host.openPopup`. Render an iframe, then call
  `sticks.mountPopup(iframe, id, tabId)`. The popup is same-origin, so the
  host can read its document to size it the way Chrome does (25–800 × 25–600).
  Call `sticks.unmountPopup(iframe)` when you hide it.
- Extension pages that open as tabs (`tabs.create`, `openOptionsPage`) reach
  `host.createTab` with a URL where `sticks.isExtensionUrl(url)` is true. Show
  those in a plain iframe with `sticks.mountPage(iframe, url, tabId)`, not in
  a STomp frame.
- `sticks.displayUrl(url)` turns a served URL back into `chrome-extension://…`
  for an address bar. `sticks.resolveUrl()` does the reverse.

## API coverage

| Namespace | Notes |
| --- | --- |
| `runtime` | `sendMessage`/`onMessage` (sendResponse, `return true`, promises), `connect`/ports, `getURL`, `getManifest`, `lastError`, `onInstalled`/`onStartup`, `openOptionsPage`, `getContexts`, external messaging between installed extensions |
| `storage` | `local`, `sync`, `session`, `managed`; `onChanged`; persisted in IndexedDB |
| `tabs`, `windows` | query/get/create/update/remove/reload/sendMessage/connect, MV2 `executeScript`/`insertCSS`, events; one window |
| `scripting` | `executeScript` (func or files, ISOLATED or MAIN), `insertCSS`/`removeCSS`, `registerContentScripts` and friends |
| `action` / `browserAction` / `pageAction` | badge text/colors, title, icon (path or ImageData), popup, enable/disable, `onClicked`, `openPopup` |
| `declarativeNetRequest` | dynamic, session and static rulesets compiled to STomp rules (see Limits) |
| `i18n` | `getMessage` with placeholders and `@@` messages; `__MSG_*__` in the manifest and in content CSS |
| `alarms`, `offscreen`, `permissions`, `contextMenus`, `notifications`, `commands`, `idle`, `management`, `cookies`, `webNavigation` | as Chrome documents them, within one browser window |
| `webRequest` | events from STomp's request reports (after the fact) |
| `privacy`, `proxy` | ChromeSetting get/set/clear; values are kept but change nothing |
| `userScripts`, `sidePanel` | accepted, not run |
| anything else the manifest asks for | a stub: calls resolve, events never fire |

## Limits

- **declarativeNetRequest.** These translate: `requestDomains`, `||host^/path`,
  `|https://…`, path substrings, resource types, methods and `domainType`, with
  the actions `block`, `allow`, `redirect.url` and `modifyHeaders` set/remove.
  Rules that use `regexFilter`, initiator conditions or exclusions are skipped.
  The total is capped by `maxRules` (default 5000; `sticks.ruleStats` reports
  how many made it). On uBlock Origin Lite's lists about 80–95% of rules
  translate. For full ad blocking, STomp's built-in `adblock` option is
  stronger.
- **webRequest** can't block or rewrite: STomp only reports a request after
  it is done.
- **chrome.proxy / VPN extensions** can't route traffic. STomp's transport
  decides where requests go.
- **Content-script scope.** Content scripts share the page's realm (STomp's
  hooks hide the proxy from them). Each `content_scripts` entry gets its own
  function scope, so separate entries don't share top-level `var`s; they can
  share state through `window`.
- **Network access** from extension pages is routed for `fetch()` only, not
  `XMLHttpRequest`.
- **Not supported:** `captureVisibleTab`, side panels and incognito. There is
  only one window.

## Development

```sh
npm run check   # tsc --noEmit
npm test        # node --test (Node 24: URLPattern and DecompressionStream)
```

`test/core.test.ts` also runs against real `.crx` files. Put any into
`test/fixtures/` (git-ignored); the test checks their ids, unpacks them and
compiles every declarativeNetRequest ruleset.
