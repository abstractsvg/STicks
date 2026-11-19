import { buildChrome } from './api/index.ts'
import { injectStyle, runInWorld, scheduleRegistration } from './content.ts'
import { createContext, eventOf, type ActionState, type ContentRegistration, type Context, type ContextKind, type DnrRule, type Extension } from './context.ts'
import { idFromKey, idFromText, parseCrx } from './crx.ts'
import { db } from './db.ts'
import { compileRules, type CompileStats } from './dnr.ts'
import { FileStore } from './files.ts'
import { getMessage, localeChain, localize, normalizeMessages, parseLooseJson, parseManifest, type Messages } from './manifest.ts'
import { scriptMatches } from './match.ts'
import type { Sender } from './messaging.ts'
import { toRealm, type Realm } from './realm.ts'
import type {
  ExtensionSummary,
  Manifest,
  StompControllerLike,
  StompHookContext,
  StompNavigateInfo,
  StompRequestInfo,
  StompRule,
  SticksHost,
  StoredExtension,
  TabInfo,
} from './types.ts'
import { readZip } from './zip.ts'

/** The global the host page exposes STicks on, for STomp's hook and extension pages. */
export const GLOBAL = '__STICKS__'

const GENERATED_BACKGROUND = '_sticks_background.html'

export interface ProxyTransportLike {
  request(remote: URL, method: string, body: BodyInit | null, headers: [string, string][], signal: AbortSignal | undefined): Promise<{
    body: BodyInit | null
    headers: [string, string][] | Record<string, string | string[]>
    status: number
    statusText: string
  }>
}

export interface SticksOptions {
  host: SticksHost
  /** where static/ is served and the STicks service worker's scope (default `/sticks/`) */
  base?: string
  /** where background and offscreen frames go (default document.body) */
  backgroundRoot?: HTMLElement
  /** a ProxyTransport for network requests from extension pages and Web Store downloads */
  transport?: ProxyTransportLike
  /** the host's own STomp rules, kept ahead of the extensions' */
  baseRules?: StompRule[]
  /** at most this many STomp rules from declarativeNetRequest (default 5000) */
  maxRules?: number
}

interface DocumentRecord {
  window: Realm
  tabId: number
  frameId: number
  url: string
  isTop: boolean
  styles: Map<string, HTMLStyleElement>
}

const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : '')

function base64Bytes(text: string) {
  const binary = atob(text.replace(/\s+/g, ''))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function pickIcon(icons: string | Record<string, string> | undefined, size = 32): string | null {
  if (!icons) return null
  if (typeof icons === 'string') return icons
  const sizes = Object.keys(icons).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  const best = sizes.find((candidate) => candidate >= size) ?? sizes[sizes.length - 1]
  return best === undefined ? null : icons[String(best)]
}

export class Sticks {
  /** STomp's `init.hooks`: pass this to `new StompController({ hooks })` so content scripts run. */
  static hooks() {
    const source = [
      `if (stomp.kind !== 'document') return;`,
      `var host = null;`,
      `try { host = stomp.window.top && stomp.window.top[${JSON.stringify(GLOBAL)}]; } catch (error) {}`,
      `if (!host) { try { host = stomp.window.opener && stomp.window.opener.top[${JSON.stringify(GLOBAL)}]; } catch (error) {} }`,
      `if (host && typeof host.attachDocument === 'function') host.attachDocument(stomp);`,
    ].join('\n')
    return { init: { post: { source } } }
  }

  readonly host: SticksHost
  readonly base: string
  readonly files: FileStore
  readonly extensions = new Map<string, Extension>()
  readonly contexts = new Set<Context>()
  readonly documents = new Map<Window, DocumentRecord>()
  controller: StompControllerLike | null = null
  ruleStats: CompileStats = { total: 0, compiled: 0, skipped: 0, truncated: 0 }

  private readonly options: SticksOptions
  private readonly listeners = new Set<() => void>()
  private readonly frameIds = new WeakMap<Window, number>()
  private nextFrameId = 1
  private loading: Promise<void> | null = null
  private startup = true
  private rulesTimer: ReturnType<typeof setTimeout> | null = null
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private requestId = 1

  constructor(options: SticksOptions) {
    this.options = options
    this.host = options.host
    this.base = (options.base ?? '/sticks/').replace(/\/?$/, '/')
    this.files = new FileStore(this.base)
    ;(window as unknown as Record<string, unknown>)[GLOBAL] = {
      attachDocument: (context: StompHookContext) => this.attachDocument(context),
      attachPage: (win: Window) => this.attachPage(win as Realm),
    }
  }

  // ---- setup ----------------------------------------------------------------

  /** Registers the STicks service worker and loads the installed extensions. */
  ready(): Promise<void> {
    this.loading ??= (async () => {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.register(`${this.base}sw.js`, { scope: this.base })
        const worker = registration.installing ?? registration.waiting
        if (worker && worker.state !== 'activated') {
          await new Promise<void>((resolve) => {
            const done = () => (worker.state === 'activated' || worker.state === 'redundant') && resolve()
            worker.addEventListener('statechange', done)
            done()
          })
        }
      }
      const stored = await db.all<StoredExtension>('extensions')
      for (const record of stored) {
        try {
          await this.load(record)
        } catch (error) {
          console.error(`[sticks] could not load ${record.id}`, error)
        }
      }
      setTimeout(() => (this.startup = false), 0)
      this.changed()
    })()
    return this.loading
  }

  /** Gives STicks the StompController: rules, cookies and (when it is an instance) the transport. */
  attach(controller: StompControllerLike) {
    this.controller = controller
    this.applyRules()
  }

  /** Pass as STomp's `init.onRequest`: feeds chrome.webRequest's events. */
  readonly onRequest = (info: StompRequestInfo) => this.observeRequest(info)

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  changed() {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      for (const listener of [...this.listeners]) listener()
    }, 30)
  }

  // ---- urls -----------------------------------------------------------------

  extensionUrl(extId: string, path = '') {
    return this.files.url(extId, path)
  }

  isExtensionUrl(url: string) {
    return url.startsWith(new URL(`${this.base}ext/`, location.origin).href) || url.startsWith('chrome-extension://')
  }

  /** chrome-extension://id/path → the URL STicks serves it from. Anything else passes through. */
  resolveUrl(url: string) {
    const match = /^chrome-extension:\/\/([a-p]{32})\/?(.*)$/.exec(url)
    return match ? this.files.url(match[1], match[2]) : url
  }

  /** The served URL back to chrome-extension://id/path, for an address bar. */
  displayUrl(url: string) {
    const prefix = new URL(`${this.base}ext/`, location.origin).href
    if (!url.startsWith(prefix)) return url
    return `chrome-extension://${url.slice(prefix.length)}`
  }

  private parseExtensionUrl(url: string) {
    const match = new RegExp(`^${new URL(`${this.base}ext/`, location.origin).href.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([a-p]{32})/?([^?#]*)`).exec(url)
    return match ? { extId: match[1], path: decodeURIComponent(match[2]) } : null
  }

  // ---- network --------------------------------------------------------------

  private transport(): ProxyTransportLike | null {
    if (this.options.transport) return this.options.transport
    const candidate = (this.controller as unknown as { transport?: unknown } | null)?.transport as ProxyTransportLike | undefined
    return candidate && typeof candidate.request === 'function' ? candidate : null
  }

  /** fetch() through the proxy's transport (no CORS, the proxy's IP); plain fetch when there is none. */
  async fetch(url: string, init: RequestInit = {}, hops = 0): Promise<Response> {
    const transport = this.transport()
    if (!transport) return fetch(url, init)
    const headers = [...new Headers(init.headers).entries()] as [string, string][]
    const body = init.body === undefined || init.body === null ? null : await new Response(init.body).arrayBuffer()
    const response = await transport.request(new URL(url), (init.method ?? 'GET').toUpperCase(), body, headers, init.signal ?? undefined)
    const raw = Array.isArray(response.headers)
      ? response.headers
      : Object.entries(response.headers).flatMap(([key, values]) => (Array.isArray(values) ? values : [values]).map((value) => [key, value] as [string, string]))
    const location = raw.find(([key]) => key.toLowerCase() === 'location')?.[1]
    if (location && response.status >= 300 && response.status < 400 && init.redirect !== 'manual') {
      if (hops >= 10) throw new TypeError('too many redirects')
      const method = response.status === 303 ? 'GET' : init.method
      return this.fetch(new URL(location, url).href, { ...init, method, body: method === 'GET' ? null : init.body }, hops + 1)
    }
    const nullBody = [101, 204, 205, 304].includes(response.status)
    return new Response(nullBody ? null : response.body, { status: response.status, statusText: response.statusText, headers: raw })
  }

  // ---- install --------------------------------------------------------------

  /** Downloads an extension from the Chrome Web Store through the proxy and installs it. */
  async installFromWebStore(id: string) {
    if (!/^[a-p]{32}$/.test(id)) throw new Error(`${id} is not an extension id`)
    const version = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '130.0.0.0'
    const response = await this.fetch(
      `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${version}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`,
    )
    if (response.status === 204) throw new Error('the Chrome Web Store does not offer this extension')
    if (!response.ok) throw new Error(`the Chrome Web Store answered ${response.status}`)
    return this.install(await response.arrayBuffer(), `${id}.crx`)
  }

  /** Installs a .crx or .zip (the host owns the file picker). Returns the extension id. */
  async install(buffer: ArrayBuffer | Uint8Array, filename = 'extension.crx'): Promise<string> {
    await this.ready()
    const { zip, crxId, publicKey } = parseCrx(buffer)
    const entries = readZip(zip).filter((entry) => !entry.name.startsWith('__MACOSX/'))
    const manifestEntry =
      entries.find((entry) => entry.name === 'manifest.json') ??
      entries
        .filter((entry) => entry.name.endsWith('/manifest.json'))
        .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0]
    if (!manifestEntry) throw new Error('the package has no manifest.json')
    const prefix = manifestEntry.name.slice(0, -'manifest.json'.length)
    const files = new Map<string, Uint8Array>()
    for (const entry of entries) {
      if (entry.name.startsWith(prefix)) files.set(entry.name.slice(prefix.length), await entry.read())
    }
    const manifest = parseManifest(decode(files.get('manifest.json')))
    let id: string
    if (typeof manifest.key === 'string' && manifest.key) id = await idFromKey(base64Bytes(manifest.key))
    else if (crxId) id = crxId
    else if (publicKey) id = await idFromKey(publicKey)
    else id = await idFromText(`${manifest.name}\n${filename}`)

    const previous = (await db.get<StoredExtension>('extensions', id)) ?? null
    if (this.extensions.has(id)) this.unload(id)
    await this.files.remove(id)
    await this.files.write(id, files)
    const stored: StoredExtension = {
      id,
      manifest,
      enabled: previous?.enabled ?? true,
      installedAt: previous?.installedAt ?? Date.now(),
      filename,
      files: [...files.keys()],
      ...(previous?.lastRunVersion ? { lastRunVersion: previous.lastRunVersion } : {}),
    }
    await db.put('extensions', id, stored)
    const ext = await this.load(stored)
    this.dispatchAll('management.onInstalled', (ctx) => [toRealm(ctx.window, this.extensionInfo(ext))])
    this.changed()
    return id
  }

  async uninstall(extId: string) {
    const ext = this.extensions.get(extId)
    if (!ext) return
    const uninstallUrl = ext.settings.get('uninstallUrl') as string | undefined
    this.unload(extId)
    await this.files.remove(extId)
    await db.delete('extensions', extId)
    for (const area of ['local', 'sync']) await db.delete('storage', `${extId}:${area}`)
    for (const key of await db.keys('state')) if (key.startsWith(`${extId}:`)) await db.delete('state', key)
    this.dispatchAll('management.onUninstalled', [extId])
    if (uninstallUrl) void this.createTab(uninstallUrl, true)
    this.applyRules()
    this.changed()
  }

  async setEnabled(extId: string, enabled: boolean) {
    const ext = this.extensions.get(extId)
    if (!ext || ext.enabled === enabled) return
    ext.enabled = enabled
    ext.stored.enabled = enabled
    await db.put('extensions', extId, ext.stored)
    if (enabled) this.startBackground(ext)
    else this.stopExtensionFrames(ext)
    this.applyRules()
    this.changed()
  }

  private catalogsFor(stored: StoredExtension) {
    return Promise.all(
      localeChain(stored.manifest.default_locale).map(async (locale) => {
        const text = await this.files.text(stored.id, `_locales/${locale}/messages.json`)
        return text ? normalizeMessages(parseLooseJson(text)) : null
      }),
    ).then((list) => list.filter((catalog): catalog is Messages => catalog !== null))
  }

  specialMessages(extId: string): Record<string, string> {
    const ui = (navigator.language || 'en').replace('-', '_')
    return {
      '@@extension_id': extId,
      '@@ui_locale': ui,
      '@@bidi_dir': 'ltr',
      '@@bidi_reversed_dir': 'rtl',
      '@@bidi_start_edge': 'left',
      '@@bidi_end_edge': 'right',
    }
  }

  message(ext: Extension, name: string, substitutions?: unknown) {
    return getMessage(ext.catalogs, name, substitutions, this.specialMessages(ext.id))
  }

  private async load(stored: StoredExtension): Promise<Extension> {
    const catalogs = await this.catalogsFor(stored)
    const special = this.specialMessages(stored.id)
    const text = (value: string | undefined) => (value === undefined ? undefined : localize(value, catalogs, special))
    const raw = stored.manifest
    const action = raw.action ?? raw.browser_action ?? raw.page_action
    const manifest: Manifest = {
      ...raw,
      name: text(raw.name) ?? raw.name,
      ...(raw.short_name ? { short_name: text(raw.short_name) } : {}),
      ...(raw.description ? { description: text(raw.description) } : {}),
    }
    const iconPath = pickIcon(action?.default_icon) ?? pickIcon(raw.icons)
    const defaultAction: ActionState = {
      title: text(action?.default_title) ?? manifest.name,
      iconUrl: iconPath ? this.files.url(stored.id, iconPath) : null,
      popup: action?.default_popup ?? null,
      badgeText: '',
      badgeColor: '#5f6368',
      badgeTextColor: null,
      enabled: true,
    }
    const state = (key: string) => db.get<unknown>('state', `${stored.id}:${key}`)
    const enabledRulesets = (await state('rulesets')) as string[] | undefined
    const ext: Extension = {
      id: stored.id,
      manifest,
      stored,
      enabled: stored.enabled,
      catalogs,
      sources: new Map(),
      storage: {
        local: ((await db.get('storage', `${stored.id}:local`)) as Record<string, unknown>) ?? {},
        sync: ((await db.get('storage', `${stored.id}:sync`)) as Record<string, unknown>) ?? {},
        session: {},
        managed: {},
      },
      action: defaultAction,
      tabAction: new Map(),
      alarms: new Map(),
      dnr: {
        dynamic: ((await state('dynamicRules')) as DnrRule[]) ?? [],
        session: [],
        enabled: new Set(enabledRulesets ?? (raw.declarative_net_request?.rule_resources ?? []).filter((set) => set.enabled).map((set) => set.id)),
        rulesets: new Map(),
      },
      registered: ((await state('scripts')) as ContentRegistration[]) ?? [],
      background: null,
      offscreen: null,
      menus: new Map(),
      settings: new Map(),
      granted: new Set([...(raw.permissions ?? []), ...(raw.host_permissions ?? [])]),
    }
    await this.loadSources(ext, this.registrations(ext))
    for (const id of ext.dnr.enabled) await this.loadRuleset(ext, id)
    this.extensions.set(ext.id, ext)
    if (ext.enabled) this.startBackground(ext)
    this.applyRules()
    return ext
  }

  private unload(extId: string) {
    const ext = this.extensions.get(extId)
    if (!ext) return
    this.stopExtensionFrames(ext)
    for (const alarm of ext.alarms.values()) clearTimeout(alarm.timer)
    for (const record of this.documents.values()) {
      for (const [key, style] of record.styles) {
        if (key.startsWith(`${extId}:`)) {
          style.remove()
          record.styles.delete(key)
        }
      }
    }
    this.extensions.delete(extId)
  }

  private stopExtensionFrames(ext: Extension) {
    for (const ctx of [...this.contexts]) if (ctx.ext === ext) this.destroyContext(ctx)
    ext.background?.remove()
    ext.background = null
    ext.offscreen?.remove()
    ext.offscreen = null
  }

  async loadRuleset(ext: Extension, id: string) {
    if (ext.dnr.rulesets.has(id)) return true
    const resource = ext.stored.manifest.declarative_net_request?.rule_resources?.find((set) => set.id === id)
    if (!resource) return false
    const text = await this.files.text(ext.id, resource.path)
    if (!text) return false
    try {
      ext.dnr.rulesets.set(id, parseLooseJson(text) as DnrRule[])
      return true
    } catch {
      return false
    }
  }

  saveState(ext: Extension, key: string, value: unknown) {
    void db.put('state', `${ext.id}:${key}`, value)
  }

  saveStorage(ext: Extension, area: 'local' | 'sync') {
    void db.put('storage', `${ext.id}:${area}`, ext.storage[area])
  }

  // ---- declarativeNetRequest → STomp rules ----------------------------------

  applyRules() {
    if (this.rulesTimer) clearTimeout(this.rulesTimer)
    this.rulesTimer = setTimeout(() => {
      this.rulesTimer = null
      const all: DnrRule[] = []
      for (const ext of this.extensions.values()) {
        if (!ext.enabled) continue
        all.push(...ext.dnr.session, ...ext.dnr.dynamic)
        for (const id of ext.dnr.enabled) all.push(...(ext.dnr.rulesets.get(id) ?? []))
      }
      const { rules, stats } = compileRules(all, this.options.maxRules ?? 5000)
      this.ruleStats = stats
      if (this.controller?.setRules) void this.controller.setRules([...(this.options.baseRules ?? []), ...rules])
    }, 100)
  }

  // ---- extension pages ------------------------------------------------------

  /** Called by static/page.js at the top of every extension page. */
  private attachPage(win: Realm) {
    const parsed = this.parseExtensionUrl(win.location.href)
    if (!parsed) return
    const ext = this.extensions.get(parsed.extId)
    if (!ext || !ext.enabled) return
    const frame = win.frameElement as HTMLIFrameElement | null
    const kind = (frame?.dataset.sticksKind as ContextKind | undefined) ?? 'page'
    let tabId: number | null = null
    if (frame?.dataset.sticksTab) tabId = Number(frame.dataset.sticksTab)
    else if (kind === 'page') tabId = this.host.getTabId(win)
    const ctx = createContext({ ext, kind, window: win, tabId, frameId: 0, url: win.location.href })
    this.contexts.add(ctx)
    const chrome = buildChrome(this, ctx)
    try {
      ;(win as unknown as { chrome: unknown }).chrome = chrome
    } catch {
      Object.defineProperty(win, 'chrome', { value: chrome, configurable: true, writable: true })
    }
    this.patchNetwork(win)
    if (kind === 'popup') {
      Object.defineProperty(win, 'close', { configurable: true, writable: true, value: () => this.closePopup(ext.id) })
    }
    if (kind === 'background' && ext.manifest.background?.service_worker) this.installWorkerShims(ctx)
    win.addEventListener('pagehide', () => this.destroyContext(ctx))
    if (kind === 'background') {
      const ready = () => setTimeout(() => this.lifecycle(ext, ctx), 0)
      if (win.document.readyState === 'complete') ready()
      else win.addEventListener('load', ready, { once: true })
    }
  }

  private patchNetwork(win: Realm) {
    const native = win.fetch.bind(win)
    win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new win.Request(input, init)
      const target = new URL(request.url)
      if (target.origin === win.location.origin || !/^https?:$/.test(target.protocol) || !this.transport()) return native(input, init)
      return new win.Promise<Response>((resolve, reject) => {
        const body = ['GET', 'HEAD'].includes(request.method) ? null : request.clone().arrayBuffer()
        Promise.resolve(body)
          .then((bytes) =>
            this.fetch(request.url, { method: request.method, headers: request.headers, body: bytes, signal: request.signal, redirect: request.redirect }),
          )
          .then(
            async (response) =>
              resolve(new win.Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: [...response.headers] })),
            (error: unknown) => reject(new win.TypeError(`Failed to fetch: ${error instanceof Error ? error.message : String(error)}`)),
          )
      })
    }) as typeof fetch
  }

  private installWorkerShims(ctx: Context) {
    const win = ctx.window as Realm & Record<string, unknown>
    const scope = this.files.url(ctx.ext.id)
    win.importScripts = (...urls: string[]) => {
      for (const url of urls) {
        const absolute = new URL(url, win.location.href).href
        const xhr = new win.XMLHttpRequest()
        xhr.open('GET', absolute, false)
        xhr.send()
        if (xhr.status !== 200) throw new win.Error(`Failed to execute 'importScripts': ${absolute} could not be loaded`)
        ;(0, win.eval)(`${xhr.responseText}\n//# sourceURL=${absolute}`)
      }
    }
    win.registration = {
      scope,
      active: null,
      installing: null,
      waiting: null,
      navigationPreload: { enable: async () => {}, disable: async () => {}, setHeaderValue: async () => {}, getState: async () => ({ enabled: false }) },
      showNotification: (title: string, options: Record<string, unknown> = {}) =>
        this.notify(ctx.ext, `sw-${Date.now()}`, { title, message: String(options.body ?? ''), iconUrl: options.icon as string | undefined }),
      getNotifications: async () => [],
      update: async () => {},
      unregister: async () => false,
      addEventListener: () => {},
    }
    win.clients = {
      matchAll: async () => [],
      claim: async () => {},
      get: async () => undefined,
      openWindow: async (url: string) => {
        await this.createTab(new URL(url, win.location.href).href, true)
        return null
      },
    }
    win.skipWaiting = async () => {}
    win.addEventListener(
      'load',
      () => {
        for (const type of ['install', 'activate']) {
          const event = new win.Event(type) as Event & { waitUntil?: (promise: unknown) => void }
          event.waitUntil = () => {}
          win.dispatchEvent(event)
        }
      },
      { once: true },
    )
  }

  private lifecycle(ext: Extension, ctx: Context) {
    if (!ctx.alive) return
    const version = ext.manifest.version ?? ''
    const last = ext.stored.lastRunVersion
    if (last === undefined) this.dispatch(ext.id, 'runtime.onInstalled', [{ reason: 'install' }])
    else if (last !== version) this.dispatch(ext.id, 'runtime.onInstalled', [{ reason: 'update', previousVersion: last }])
    else if (this.startup) this.dispatch(ext.id, 'runtime.onStartup', [])
    if (last !== version) {
      ext.stored.lastRunVersion = version
      void db.put('extensions', ext.id, ext.stored)
    }
  }

  private hiddenFrame(kind: ContextKind, url: string) {
    const frame = document.createElement('iframe')
    frame.dataset.sticksKind = kind
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
    frame.src = url
    ;(this.options.backgroundRoot ?? document.body).append(frame)
    return frame
  }

  startBackground(ext: Extension) {
    if (ext.background || !ext.enabled) return
    const background = ext.stored.manifest.background
    let url: string | null = null
    if (background?.service_worker) {
      const params = new URLSearchParams({ sw: '1', m: background.type === 'module' ? '1' : '0' })
      params.append('s', background.service_worker.replace(/^\/+/, ''))
      url = `${this.files.url(ext.id, GENERATED_BACKGROUND)}?${params}`
    } else if (background?.page) {
      url = this.files.url(ext.id, background.page)
    } else if (background?.scripts?.length) {
      const params = new URLSearchParams()
      for (const script of background.scripts) params.append('s', script.replace(/^\/+/, ''))
      url = `${this.files.url(ext.id, GENERATED_BACKGROUND)}?${params}`
    }
    if (url) ext.background = this.hiddenFrame('background', url)
  }

  /** Resolves once the extension's background page has loaded (at most 5 s), like Chrome waking a worker. */
  backgroundReady(ext: Extension): Promise<void> {
    const frame = ext.background
    if (!frame) return Promise.resolve()
    const loaded = () => {
      try {
        return frame.contentWindow?.document.readyState === 'complete' && this.contextsOf(ext.id, (ctx) => ctx.kind === 'background').length > 0
      } catch {
        return true
      }
    }
    if (loaded()) return Promise.resolve()
    return new Promise((resolve) => {
      const started = Date.now()
      const check = () => (loaded() || Date.now() - started > 5000 ? resolve() : setTimeout(check, 50))
      check()
    })
  }

  async openOffscreen(ext: Extension, path: string) {
    if (ext.offscreen) throw new Error('Only a single offscreen document may be created.')
    const frame = this.hiddenFrame('offscreen', this.files.url(ext.id, path))
    ext.offscreen = frame
    await new Promise<void>((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true })
      setTimeout(resolve, 10_000)
    })
  }

  closeOffscreen(ext: Extension) {
    for (const ctx of [...this.contexts]) if (ctx.ext === ext && ctx.kind === 'offscreen') this.destroyContext(ctx)
    ext.offscreen?.remove()
    ext.offscreen = null
  }

  // ---- popups ---------------------------------------------------------------

  private popupFrames = new Map<string, HTMLIFrameElement>()

  /** The toolbar button was clicked: opens the popup through the host, or fires action.onClicked. */
  clickAction(extId: string, tabId: number | null = this.host.getActiveTabId()) {
    const ext = this.extensions.get(extId)
    if (!ext?.enabled) return null
    const state = this.actionState(ext, tabId)
    if (!state.enabled) return 'disabled'
    if (state.popup && this.host.openPopup?.(extId, tabId) !== false && this.host.openPopup) return 'popup'
    const tab = tabId === null ? undefined : this.host.getTab(tabId)
    const mv3 = Number(ext.manifest.manifest_version) >= 3
    this.dispatch(extId, mv3 ? 'action.onClicked' : 'browserAction.onClicked', (ctx) => [toRealm(ctx.window, tab)])
    return 'clicked'
  }

  /** Loads the popup into an iframe the host shows; the page sizes itself, the host reads its document to fit. */
  mountPopup(frame: HTMLIFrameElement, extId: string, tabId: number | null = this.host.getActiveTabId()) {
    const ext = this.extensions.get(extId)
    const popup = ext ? this.actionState(ext, tabId).popup : null
    if (!ext || !popup) return false
    frame.dataset.sticksKind = 'popup'
    if (tabId !== null) frame.dataset.sticksTab = String(tabId)
    frame.src = this.files.url(extId, popup)
    this.popupFrames.set(extId, frame)
    return true
  }

  unmountPopup(frame: HTMLIFrameElement) {
    for (const [extId, candidate] of this.popupFrames) if (candidate === frame) this.popupFrames.delete(extId)
    try {
      frame.src = 'about:blank'
    } catch {
      return
    }
  }

  closePopup(extId: string) {
    const frame = this.popupFrames.get(extId)
    this.host.closePopup?.(extId)
    if (frame) this.unmountPopup(frame)
  }

  /** Loads an extension page (options, a tab an extension opened) into a plain iframe the host owns. */
  mountPage(frame: HTMLIFrameElement, url: string, tabId: number | null) {
    frame.dataset.sticksKind = 'page'
    if (tabId !== null) frame.dataset.sticksTab = String(tabId)
    frame.src = this.resolveUrl(url)
  }

  // ---- contexts ---------------------------------------------------------------

  destroyContext(ctx: Context) {
    if (!ctx.alive) return
    ctx.alive = false
    for (const dispose of ctx.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        continue
      }
    }
    ctx.events.clear()
    this.contexts.delete(ctx)
  }

  contextsOf(extId: string, accept: (ctx: Context) => boolean = () => true) {
    return [...this.contexts].filter((ctx) => ctx.alive && ctx.ext.id === extId && accept(ctx))
  }

  /** Fires `event` in every context of one extension. */
  dispatch(extId: string, event: string, args: unknown[] | ((ctx: Context) => unknown[]), accept?: (options: unknown) => boolean) {
    for (const ctx of this.contextsOf(extId)) {
      const target = ctx.events.get(event)
      if (target?.listeners.length) target.dispatch(typeof args === 'function' ? args(ctx) : args, accept)
    }
  }

  dispatchAll(event: string, args: unknown[] | ((ctx: Context) => unknown[]), accept?: (options: unknown) => boolean) {
    for (const ext of this.extensions.values()) if (ext.enabled) this.dispatch(ext.id, event, args, accept)
  }

  sender(ctx: Context): Sender {
    const sender: Sender = { id: ctx.ext.id, url: ctx.kind === 'content' ? ctx.url : this.displayUrl(ctx.url) }
    try {
      sender.origin = new URL(sender.url!).origin
    } catch {
      sender.origin = undefined
    }
    if (ctx.tabId !== null && (ctx.kind === 'content' || ctx.kind === 'page')) {
      const tab = this.host.getTab(ctx.tabId)
      if (tab) sender.tab = tab
      sender.frameId = ctx.frameId
    }
    return sender
  }

  // ---- content scripts ------------------------------------------------------

  private registrations(ext: Extension): ContentRegistration[] {
    const fromManifest = (ext.stored.manifest.content_scripts ?? []).map<ContentRegistration>((entry) => ({
      source: 'manifest',
      matches: entry.matches ?? [],
      exclude_matches: entry.exclude_matches,
      include_globs: entry.include_globs,
      exclude_globs: entry.exclude_globs,
      js: entry.js ?? [],
      css: entry.css ?? [],
      run_at: entry.run_at ?? 'document_idle',
      all_frames: !!entry.all_frames,
      world: entry.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
    }))
    return [...fromManifest, ...ext.registered]
  }

  async loadSources(ext: Extension, registrations: ContentRegistration[]) {
    for (const registration of registrations) {
      for (const path of [...registration.js, ...registration.css]) {
        const clean = path.replace(/^\/+/, '')
        if (ext.sources.has(clean)) continue
        let text = (await this.files.text(ext.id, clean)) ?? ''
        if (clean.endsWith('.css')) text = this.localizeCss(ext, text)
        ext.sources.set(clean, text)
      }
    }
  }

  localizeCss(ext: Extension, css: string) {
    return localize(css, ext.catalogs, this.specialMessages(ext.id)).replace(/chrome-extension:\/\/([a-p]{32})\//g, (_, id: string) => this.files.url(id))
  }

  /** STomp's post hook, in every proxied document: decides which content scripts run there. */
  private attachDocument(hook: StompHookContext) {
    if (hook.kind !== 'document') return
    const win = hook.window as Realm
    let top: Window = win
    try {
      while (top.parent !== top && top.parent !== window) top = top.parent
    } catch {
      return
    }
    if (top.parent !== window) return
    const tabId = this.host.getTabId(top)
    if (tabId === null) return
    const isTop = hook.isTop || win === top
    const record: DocumentRecord = { window: win, tabId, frameId: isTop ? 0 : this.frameIdOf(win), url: hook.url, isTop, styles: new Map() }
    this.documents.set(win, record)
    win.addEventListener('pagehide', () => {
      if (this.documents.get(win) === record) this.documents.delete(win)
      for (const ctx of [...this.contexts]) if (ctx.window === win) this.destroyContext(ctx)
    })
    for (const ext of this.extensions.values()) {
      if (!ext.enabled) continue
      for (const registration of this.registrations(ext)) {
        if (!registration.all_frames && !isTop) continue
        if (!scriptMatches(registration, hook.url)) continue
        scheduleRegistration(this, record, ext, registration)
      }
    }
  }

  frameIdOf(win: Window) {
    let id = this.frameIds.get(win)
    if (id === undefined) {
      id = this.nextFrameId++
      this.frameIds.set(win, id)
    }
    return id
  }

  /** The isolated-world context one extension has in one document (made on first use). */
  contentContext(record: DocumentRecord, ext: Extension): Context {
    const existing = [...this.contexts].find((ctx) => ctx.alive && ctx.kind === 'content' && ctx.window === record.window && ctx.ext === ext)
    if (existing) return existing
    const ctx = createContext({ ext, kind: 'content', window: record.window, tabId: record.tabId, frameId: record.frameId, url: record.url })
    this.contexts.add(ctx)
    contextChrome.set(ctx, buildChrome(this, ctx))
    return ctx
  }

  chromeFor(ctx: Context) {
    return contextChrome.get(ctx)
  }

  documentsOf(tabId: number, frameIds?: number[], allFrames = false) {
    return [...this.documents.values()].filter((record) => {
      if (record.tabId !== tabId) return false
      if (frameIds) return frameIds.includes(record.frameId)
      return allFrames || record.isTop
    })
  }

  /** scripting.executeScript / tabs.executeScript: runs code in a tab's documents, returns each result. */
  async execute(ext: Extension, tabId: number, target: { frameIds?: number[]; allFrames?: boolean }, code: string, world: 'ISOLATED' | 'MAIN') {
    const records = this.documentsOf(tabId, target.frameIds, target.allFrames)
    if (!records.length) throw new Error(`Cannot access contents of the page in tab ${tabId}.`)
    const results: { frameId: number; documentId: string; result: unknown }[] = []
    for (const record of records) {
      const value = runInWorld(this, record, ext, code, world, true)
      results.push({ frameId: record.frameId, documentId: String(record.frameId), result: await Promise.resolve(value).catch(() => null) })
    }
    return results
  }

  insertCss(ext: Extension, tabId: number, target: { frameIds?: number[]; allFrames?: boolean }, css: string, key: string) {
    for (const record of this.documentsOf(tabId, target.frameIds, target.allFrames)) injectStyle(record, `${ext.id}:${key}`, this.localizeCss(ext, css))
  }

  removeCss(ext: Extension, tabId: number, target: { frameIds?: number[]; allFrames?: boolean }, key: string) {
    for (const record of this.documentsOf(tabId, target.frameIds, target.allFrames)) {
      const style = record.styles.get(`${ext.id}:${key}`)
      style?.remove()
      record.styles.delete(`${ext.id}:${key}`)
    }
  }

  // ---- tabs -----------------------------------------------------------------

  async createTab(url: string, active: boolean, openerTabId?: number) {
    return (await this.host.createTab?.(this.resolveUrl(url), { active, openerTabId })) ?? null
  }

  tab(tabId: number | null): TabInfo | null {
    return tabId === null ? null : this.host.getTab(tabId)
  }

  /** Tell STicks a tab appeared. */
  tabCreated(tabId: number) {
    const tab = this.host.getTab(tabId)
    if (tab) this.dispatchAll('tabs.onCreated', (ctx) => [toRealm(ctx.window, tab)])
  }

  /** Tell STicks a tab changed (STomp's onNavigate is the usual source; see navigated()). */
  tabUpdated(tabId: number, change: Partial<Pick<TabInfo, 'url' | 'title' | 'status' | 'favIconUrl'>>) {
    const tab = this.host.getTab(tabId)
    if (!tab) return
    if (change.status === 'loading' && change.url) {
      for (const ext of this.extensions.values()) ext.tabAction.delete(tabId)
      this.changed()
    }
    this.dispatchAll('tabs.onUpdated', (ctx) => [tabId, toRealm(ctx.window, change), toRealm(ctx.window, tab)])
  }

  /** STomp's onNavigate for a tab. */
  navigated(tabId: number, info: StompNavigateInfo) {
    this.tabUpdated(tabId, { url: info.url, title: info.title, status: 'complete', ...(info.icon ? { favIconUrl: info.icon } : {}) })
    this.dispatchAll('webNavigation.onCompleted', (ctx) => [toRealm(ctx.window, { tabId, frameId: 0, url: info.url, timeStamp: Date.now() })])
  }

  tabActivated(tabId: number) {
    this.dispatchAll('tabs.onActivated', [{ tabId, windowId: 1 }])
    this.changed()
  }

  tabRemoved(tabId: number) {
    for (const record of [...this.documents.values()]) if (record.tabId === tabId) this.documents.delete(record.window)
    for (const ctx of [...this.contexts]) if (ctx.kind === 'content' && ctx.tabId === tabId) this.destroyContext(ctx)
    for (const ext of this.extensions.values()) ext.tabAction.delete(tabId)
    this.dispatchAll('tabs.onRemoved', [tabId, { windowId: 1, isWindowClosing: false }])
  }

  // ---- toolbar --------------------------------------------------------------

  actionState(ext: Extension, tabId: number | null): ActionState {
    return { ...ext.action, ...(tabId === null ? {} : ext.tabAction.get(tabId)) }
  }

  /** What the host's toolbar shows, per extension, for one tab. */
  list(tabId: number | null = this.host.getActiveTabId()): ExtensionSummary[] {
    return [...this.extensions.values()].map((ext) => {
      const state = this.actionState(ext, tabId)
      const options = ext.manifest.options_ui?.page ?? ext.manifest.options_page
      return {
        id: ext.id,
        name: ext.manifest.name,
        version: ext.manifest.version ?? '',
        description: ext.manifest.description ?? '',
        enabled: ext.enabled,
        manifest: ext.manifest,
        iconUrl: state.iconUrl,
        title: state.title ?? ext.manifest.name,
        badgeText: state.badgeText,
        badgeColor: state.badgeColor,
        badgeTextColor: state.badgeTextColor,
        hasPopup: !!state.popup,
        popupUrl: state.popup ? this.files.url(ext.id, state.popup) : null,
        optionsUrl: options ? this.files.url(ext.id, options) : null,
        actionEnabled: state.enabled,
      }
    })
  }

  extensionInfo(ext: Extension) {
    return {
      id: ext.id,
      name: ext.manifest.name,
      shortName: ext.manifest.short_name ?? ext.manifest.name,
      description: ext.manifest.description ?? '',
      version: ext.manifest.version ?? '',
      enabled: ext.enabled,
      type: 'extension',
      installType: 'normal',
      mayDisable: true,
      isApp: false,
      offlineEnabled: false,
      optionsUrl: ext.manifest.options_ui?.page ? this.files.url(ext.id, ext.manifest.options_ui.page) : '',
      permissions: ext.stored.manifest.permissions ?? [],
      hostPermissions: ext.stored.manifest.host_permissions ?? [],
      icons: Object.entries(ext.stored.manifest.icons ?? {}).map(([size, path]) => ({ size: Number(size), url: this.files.url(ext.id, path) })),
    }
  }

  notify(ext: Extension, id: string, options: { title?: string; message?: string; iconUrl?: string; [key: string]: unknown }) {
    const iconUrl = options.iconUrl && !/^(https?|data|blob):/.test(options.iconUrl) ? this.files.url(ext.id, options.iconUrl) : options.iconUrl
    this.host.showNotification?.(ext.id, id, { ...options, iconUrl })
    return id
  }

  /** The host's notification UI was clicked / closed / a button pressed. */
  notificationEvent(extId: string, id: string, event: 'clicked' | 'closed' | 'button', buttonIndex = 0) {
    if (event === 'clicked') this.dispatch(extId, 'notifications.onClicked', [id])
    if (event === 'closed') this.dispatch(extId, 'notifications.onClosed', [id, true])
    if (event === 'button') this.dispatch(extId, 'notifications.onButtonClicked', [id, buttonIndex])
  }

  /** A keyboard shortcut the host matched to an extension command. */
  triggerCommand(extId: string, name: string, tabId: number | null = this.host.getActiveTabId()) {
    if (name === '_execute_action' || name === '_execute_browser_action') return this.clickAction(extId, tabId)
    const tab = this.tab(tabId)
    this.dispatch(extId, 'commands.onCommand', (ctx) => [name, toRealm(ctx.window, tab ?? undefined)])
    return 'command'
  }

  // ---- webRequest (observational) -------------------------------------------

  private observeRequest(info: StompRequestInfo) {
    const frameWindow = info.frame?.element?.contentWindow ?? null
    const tabId = frameWindow ? this.host.getTabId(frameWindow) ?? -1 : -1
    const type = RESOURCE_TYPES[info.destination] ?? 'other'
    const base = { requestId: String(this.requestId++), url: info.url, method: info.method, frameId: type === 'main_frame' ? 0 : -1, parentFrameId: -1, tabId, type, timeStamp: Date.now() }
    const accept = (options: unknown) => {
      const filter = options as { urls?: string[]; types?: string[]; tabId?: number } | undefined
      if (!filter) return true
      if (filter.types && !filter.types.includes(type)) return false
      if (filter.tabId !== undefined && filter.tabId !== tabId) return false
      return !filter.urls || filter.urls.some((pattern) => pattern === '<all_urls>' || scriptMatches({ matches: [pattern] }, info.url))
    }
    for (const ext of this.extensions.values()) {
      if (!ext.enabled || !ext.granted.has('webRequest')) continue
      this.dispatch(ext.id, 'webRequest.onBeforeRequest', (ctx) => [toRealm(ctx.window, base)], accept)
      if (info.status === 0 || info.error) {
        this.dispatch(ext.id, 'webRequest.onErrorOccurred', (ctx) => [toRealm(ctx.window, { ...base, error: info.error ?? 'net::ERR_FAILED' })], accept)
      } else {
        this.dispatch(ext.id, 'webRequest.onCompleted', (ctx) => [toRealm(ctx.window, { ...base, statusCode: info.status, fromCache: false })], accept)
      }
    }
  }

  // ---- helpers used by the APIs ---------------------------------------------

  eventApi(ctx: Context, name: string) {
    return eventOf(ctx, name).api
  }
}

const contextChrome = new WeakMap<Context, Record<string, unknown>>()

const RESOURCE_TYPES: Record<string, string> = {
  document: 'main_frame',
  iframe: 'sub_frame',
  frame: 'sub_frame',
  style: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  embed: 'object',
  fetch: 'xmlhttprequest',
  audio: 'media',
  video: 'media',
  track: 'media',
  report: 'csp_report',
}

export type { DocumentRecord }
