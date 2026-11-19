import type { ContentRegistration } from '../context.ts'
import { matchesAny } from '../match.ts'
import { deliverMessage, NO_RECEIVER, openPort } from '../messaging.ts'
import { ApiError } from '../realm.ts'
import type { TabInfo } from '../types.ts'
import type { Env } from './env.ts'

type QueryInfo = {
  active?: boolean
  currentWindow?: boolean
  lastFocusedWindow?: boolean
  windowId?: number
  url?: string | string[]
  title?: string
  status?: string
  index?: number
  pinned?: boolean
  audible?: boolean
  highlighted?: boolean
}

type Target = { tabId: number; frameIds?: number[]; allFrames?: boolean; documentIds?: string[] }

const globMatch = (glob: string, text: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(text)

function matchesQuery(info: QueryInfo, tab: TabInfo) {
  if (info.active !== undefined && tab.active !== info.active) return false
  if (info.highlighted !== undefined && tab.active !== info.highlighted) return false
  if (info.windowId !== undefined && info.windowId >= 0 && tab.windowId !== info.windowId) return false
  if (info.url !== undefined && !matchesAny(Array.isArray(info.url) ? info.url : [info.url], tab.url)) return false
  if (info.title !== undefined && !globMatch(info.title, tab.title)) return false
  if (info.status !== undefined && (tab.status ?? 'complete') !== info.status) return false
  if (info.index !== undefined && tab.index !== info.index) return false
  if (info.pinned !== undefined && !!tab.pinned !== info.pinned) return false
  if (info.audible !== undefined && !!tab.audible !== info.audible) return false
  return true
}

const WINDOW = (tabs?: TabInfo[]) => ({
  id: 1,
  focused: true,
  top: 0,
  left: 0,
  width: window.innerWidth,
  height: window.innerHeight,
  incognito: false,
  type: 'normal',
  state: 'normal',
  alwaysOnTop: false,
  ...(tabs ? { tabs } : {}),
})

export function tabs(env: Env) {
  const { s, ctx, ext } = env
  const activeTab = () => {
    const id = s.host.getActiveTabId()
    if (id === null) throw new ApiError('No active tab.')
    return id
  }
  const resolve = (url: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return s.resolveUrl(url)
    return new URL(url, ctx.kind === 'content' ? s.extensionUrl(ext.id) : ctx.url).href
  }
  const tabOrThrow = (tabId: number) => {
    const tab = s.tab(tabId)
    if (!tab) throw new ApiError(`No tab with id: ${tabId}.`)
    return tab
  }
  const contentIn = (tabId: number, frameId?: number) =>
    s.contextsOf(ext.id, (other) => other.kind === 'content' && other.tabId === tabId && (frameId === undefined || other.frameId === frameId))

  const executeLegacy = env.m(async (a: unknown, b: unknown) => {
    const [tabId, details] = typeof a === 'number' ? [a, b as Record<string, unknown>] : [activeTab(), a as Record<string, unknown>]
    const code = typeof details.code === 'string' ? details.code : ((await s.files.text(ext.id, String(details.file ?? ''))) ?? '')
    const results = await s.execute(ext, tabId, { allFrames: !!details.allFrames, frameIds: typeof details.frameId === 'number' ? [details.frameId] : undefined }, code, 'ISOLATED')
    return results.map((result) => result.result)
  })

  const css = (remove: boolean) =>
    env.m(async (a: unknown, b: unknown) => {
      const [tabId, details] = typeof a === 'number' ? [a, b as Record<string, unknown>] : [activeTab(), a as Record<string, unknown>]
      const key = typeof details.file === 'string' ? `file:${details.file}` : `code:${details.code}`
      const target = { allFrames: !!details.allFrames, frameIds: typeof details.frameId === 'number' ? [details.frameId] : undefined }
      if (remove) return s.removeCss(ext, tabId, target, key)
      const text = typeof details.code === 'string' ? details.code : ((await s.files.text(ext.id, String(details.file ?? ''))) ?? '')
      s.insertCss(ext, tabId, target, text, key)
    }, { voidResult: true })

  return env.obj({
    TAB_ID_NONE: -1,
    TAB_INDEX_NONE: -1,
    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
    query: env.m((info: QueryInfo = {}) => s.host.getTabs().filter((tab) => matchesQuery(info, tab))),
    get: env.m((tabId: number) => tabOrThrow(tabId)),
    getCurrent: env.m(() => (ctx.kind === 'page' && ctx.tabId !== null ? (s.tab(ctx.tabId) ?? undefined) : undefined)),
    create: env.m(async (props: { url?: string; active?: boolean; selected?: boolean; openerTabId?: number } = {}) => {
      const id = await s.createTab(resolve(props.url ?? 'about:blank'), props.active ?? props.selected ?? true, props.openerTabId)
      if (id === null) throw new ApiError('Tabs cannot be created here.')
      return s.tab(id) ?? { id, windowId: 1, index: -1, url: props.url ?? '', title: '', active: props.active !== false }
    }),
    update: env.m((a: unknown, b: unknown) => {
      const [tabId, props] = typeof a === 'number' ? [a, (b ?? {}) as Record<string, unknown>] : [activeTab(), (a ?? {}) as Record<string, unknown>]
      tabOrThrow(tabId)
      if (typeof props.url === 'string') s.host.navigateTab?.(tabId, resolve(props.url))
      if (props.active || props.highlighted) s.host.activateTab?.(tabId)
      return s.tab(tabId)
    }),
    remove: env.m((ids: number | number[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) s.host.closeTab?.(id)
    }, { voidResult: true }),
    reload: env.m((a?: unknown) => s.host.reloadTab?.(typeof a === 'number' ? a : activeTab()), { voidResult: true }),
    goBack: env.m((a?: unknown) => s.host.goBack?.(typeof a === 'number' ? a : activeTab()), { voidResult: true }),
    goForward: env.m((a?: unknown) => s.host.goForward?.(typeof a === 'number' ? a : activeTab()), { voidResult: true }),
    duplicate: env.m(async (tabId: number) => {
      const id = await s.createTab(tabOrThrow(tabId).url, true, tabId)
      return id === null ? undefined : s.tab(id)
    }),
    highlight: env.m((info: { tabs: number | number[] }) => {
      const first = Array.isArray(info.tabs) ? info.tabs[0] : info.tabs
      if (typeof first === 'number') s.host.activateTab?.(first)
      return WINDOW()
    }),
    move: env.m((ids: number | number[]) => (Array.isArray(ids) ? ids.map((id) => s.tab(id)) : s.tab(ids))),
    discard: env.m((tabId?: number) => (tabId === undefined ? undefined : s.tab(tabId))),
    setZoom: env.m(() => {}, { voidResult: true }),
    getZoom: env.m(() => 1),
    getZoomSettings: env.m(() => ({ mode: 'automatic', scope: 'per-origin', defaultZoomFactor: 1 })),
    detectLanguage: env.m(() => 'und'),
    captureVisibleTab: env.m(() => {
      throw new ApiError('captureVisibleTab is not supported by STicks.')
    }),
    sendMessage: env.m(async (tabId: number, message: unknown, options: { frameId?: number } = {}) => {
      tabOrThrow(tabId)
      const targets = contentIn(tabId, options?.frameId)
      if (!targets.length) throw new ApiError(NO_RECEIVER)
      return deliverMessage(targets, 'runtime.onMessage', message, s.sender(ctx))
    }),
    connect: (tabId: number, info: { name?: string; frameId?: number } = {}) =>
      openPort(ctx, () => contentIn(tabId, info.frameId), 'runtime.onConnect', String(info.name ?? ''), s.sender(ctx)),
    executeScript: executeLegacy,
    insertCSS: css(false),
    removeCSS: css(true),
    onCreated: env.event('tabs.onCreated'),
    onUpdated: env.event('tabs.onUpdated'),
    onActivated: env.event('tabs.onActivated'),
    onRemoved: env.event('tabs.onRemoved'),
    onReplaced: env.event('tabs.onReplaced'),
    onMoved: env.event('tabs.onMoved'),
    onHighlighted: env.event('tabs.onHighlighted'),
    onAttached: env.event('tabs.onAttached'),
    onDetached: env.event('tabs.onDetached'),
    onZoomChange: env.event('tabs.onZoomChange'),
  })
}

export function windows(env: Env) {
  const { s } = env
  const current = (info?: { populate?: boolean }) => WINDOW(info?.populate ? s.host.getTabs() : undefined)
  return env.obj({
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    get: env.m((_id: number, info?: { populate?: boolean }) => current(info)),
    getCurrent: env.m((info?: { populate?: boolean }) => current(info)),
    getLastFocused: env.m((info?: { populate?: boolean }) => current(info)),
    getAll: env.m((info?: { populate?: boolean }) => [current(info)]),
    create: env.m(async (data: { url?: string | string[] } = {}) => {
      for (const url of Array.isArray(data.url) ? data.url : data.url ? [data.url] : []) await s.createTab(url, true)
      return current({ populate: true })
    }),
    update: env.m(() => current()),
    remove: env.m(() => {}, { voidResult: true }),
    onCreated: env.event('windows.onCreated'),
    onRemoved: env.event('windows.onRemoved'),
    onFocusChanged: env.event('windows.onFocusChanged'),
    onBoundsChanged: env.event('windows.onBoundsChanged'),
  })
}

export function scripting(env: Env) {
  const { s, ext } = env
  const keyOf = (injection: { css?: string; files?: string[] }) => (injection.files ? `files:${injection.files.join(',')}` : `css:${injection.css}`)
  const toRegistration = (script: Record<string, unknown>): ContentRegistration => ({
    id: String(script.id),
    source: 'scripting',
    matches: (script.matches as string[]) ?? [],
    exclude_matches: script.excludeMatches as string[] | undefined,
    js: (script.js as string[]) ?? [],
    css: (script.css as string[]) ?? [],
    run_at: (script.runAt as ContentRegistration['run_at']) ?? 'document_idle',
    all_frames: !!script.allFrames,
    world: script.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
    persistAcrossSessions: script.persistAcrossSessions !== false,
  })
  const fromRegistration = (registration: ContentRegistration) => ({
    id: registration.id,
    matches: registration.matches,
    excludeMatches: registration.exclude_matches ?? [],
    js: registration.js,
    css: registration.css,
    runAt: registration.run_at,
    allFrames: registration.all_frames,
    world: registration.world,
    persistAcrossSessions: registration.persistAcrossSessions !== false,
  })
  const persist = () => s.saveState(ext, 'scripts', ext.registered.filter((registration) => registration.persistAcrossSessions !== false))
  const pick = (filter?: { ids?: string[] }) => (registration: ContentRegistration) => !filter?.ids || filter.ids.includes(String(registration.id))

  return env.obj({
    ExecutionWorld: { ISOLATED: 'ISOLATED', MAIN: 'MAIN' },
    StyleOrigin: { AUTHOR: 'AUTHOR', USER: 'USER' },
    executeScript: env.m(async (injection: { target: Target; func?: (...args: unknown[]) => unknown; function?: (...args: unknown[]) => unknown; args?: unknown[]; files?: string[]; world?: 'ISOLATED' | 'MAIN' }) => {
      const fn = injection.func ?? injection.function
      let code: string
      if (fn) code = `return (${String(fn)}).apply(this, ${JSON.stringify(injection.args ?? [])})`
      else if (injection.files?.length) code = (await Promise.all(injection.files.map((file) => s.files.text(ext.id, file)))).map((text) => text ?? '').join('\n;\n')
      else throw new ApiError('Exactly one of func and files must be specified.')
      return s.execute(ext, injection.target.tabId, injection.target, code, injection.world === 'MAIN' ? 'MAIN' : 'ISOLATED')
    }),
    insertCSS: env.m(async (injection: { target: Target; css?: string; files?: string[] }) => {
      const css = injection.css ?? (await Promise.all((injection.files ?? []).map((file) => s.files.text(ext.id, file)))).join('\n')
      s.insertCss(ext, injection.target.tabId, injection.target, css, keyOf(injection))
    }, { voidResult: true }),
    removeCSS: env.m((injection: { target: Target; css?: string; files?: string[] }) => s.removeCss(ext, injection.target.tabId, injection.target, keyOf(injection)), { voidResult: true }),
    registerContentScripts: env.m(async (scripts: Record<string, unknown>[]) => {
      const added = scripts.map(toRegistration)
      for (const registration of added) {
        if (ext.registered.some((existing) => existing.id === registration.id)) throw new ApiError(`Duplicate script ID '${registration.id}'`)
      }
      await s.loadSources(ext, added)
      ext.registered.push(...added)
      persist()
    }, { voidResult: true }),
    getRegisteredContentScripts: env.m((filter?: { ids?: string[] }) => ext.registered.filter(pick(filter)).map(fromRegistration)),
    unregisterContentScripts: env.m((filter?: { ids?: string[] }) => {
      ext.registered = ext.registered.filter((registration) => !pick(filter)(registration))
      persist()
    }, { voidResult: true }),
    updateContentScripts: env.m(async (scripts: Record<string, unknown>[]) => {
      for (const script of scripts) {
        const index = ext.registered.findIndex((registration) => registration.id === String(script.id))
        if (index < 0) throw new ApiError(`Script with ID '${String(script.id)}' does not exist.`)
        const merged = toRegistration({ ...fromRegistration(ext.registered[index]), ...script })
        await s.loadSources(ext, [merged])
        ext.registered[index] = merged
      }
      persist()
    }, { voidResult: true }),
  })
}
