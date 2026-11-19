import { matchesAny } from '../match.ts'
import { ApiError, toRealm } from '../realm.ts'
import type { Env } from './env.ts'

export function alarms(env: Env) {
  const { s, ext } = env
  const info = (alarm: { name: string; scheduledTime: number; periodInMinutes?: number }) => ({
    name: alarm.name,
    scheduledTime: alarm.scheduledTime,
    ...(alarm.periodInMinutes ? { periodInMinutes: alarm.periodInMinutes } : {}),
  })
  const clear = (name: string) => {
    const alarm = ext.alarms.get(name)
    if (!alarm) return false
    clearTimeout(alarm.timer)
    ext.alarms.delete(name)
    return true
  }
  const schedule = (name: string, when: number, periodInMinutes?: number) => {
    clear(name)
    const fire = () => {
      const alarm = ext.alarms.get(name)
      if (!alarm) return
      s.dispatch(ext.id, 'alarms.onAlarm', (ctx) => [toRealm(ctx.window, info(alarm))])
      if (alarm.periodInMinutes) {
        alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60_000
        alarm.timer = setTimeout(fire, alarm.periodInMinutes * 60_000)
      } else {
        ext.alarms.delete(name)
      }
    }
    ext.alarms.set(name, { name, scheduledTime: when, periodInMinutes, timer: setTimeout(fire, Math.max(0, when - Date.now())) })
  }
  return env.obj({
    create: env.m((a?: unknown, b?: unknown) => {
      const [name, options] = typeof a === 'string' ? [a, (b ?? {}) as Record<string, number>] : ['', (a ?? {}) as Record<string, number>]
      const when = options.when ?? Date.now() + (options.delayInMinutes ?? options.periodInMinutes ?? 0) * 60_000
      schedule(name, when, options.periodInMinutes)
    }, { voidResult: true }),
    get: env.m((name = '') => {
      const alarm = ext.alarms.get(String(name))
      return alarm ? info(alarm) : undefined
    }),
    getAll: env.m(() => [...ext.alarms.values()].map(info)),
    clear: env.m((name = '') => clear(String(name))),
    clearAll: env.m(() => {
      for (const name of [...ext.alarms.keys()]) clear(name)
      return true
    }),
    onAlarm: env.event('alarms.onAlarm'),
  })
}

export function offscreen(env: Env) {
  const { s, ext } = env
  return env.obj({
    Reason: Object.fromEntries(
      ['TESTING', 'AUDIO_PLAYBACK', 'IFRAME_SCRIPTING', 'DOM_SCRAPING', 'BLOBS', 'DOM_PARSER', 'USER_MEDIA', 'DISPLAY_MEDIA', 'WEB_RTC', 'CLIPBOARD', 'LOCAL_STORAGE', 'WORKERS', 'BATTERY_STATUS', 'MATCH_MEDIA', 'GEOLOCATION'].map((reason) => [reason, reason]),
    ),
    createDocument: env.m((parameters: { url: string }) => s.openOffscreen(ext, String(parameters.url).replace(/^\/+/, '')), { voidResult: true }),
    closeDocument: env.m(() => {
      if (!ext.offscreen) throw new ApiError('No current offscreen document.')
      s.closeOffscreen(ext)
    }, { voidResult: true }),
    hasDocument: env.m(() => !!ext.offscreen),
  })
}

export function permissions(env: Env) {
  const { s, ext } = env
  const has = (request: { permissions?: string[]; origins?: string[] } = {}) =>
    (request.permissions ?? []).every((permission) => ext.granted.has(permission)) &&
    (request.origins ?? []).every((origin) => ext.granted.has(origin) || ext.granted.has('<all_urls>') || [...ext.granted].some((granted) => granted.includes('://') && matchesAny([granted], origin.replace(/\*$/, ''))))
  return env.obj({
    contains: env.m((request: { permissions?: string[]; origins?: string[] }) => has(request)),
    getAll: env.m(() => ({
      permissions: [...ext.granted].filter((permission) => !permission.includes('://') && permission !== '<all_urls>'),
      origins: [...ext.granted].filter((permission) => permission.includes('://') || permission === '<all_urls>'),
    })),
    request: env.m((request: { permissions?: string[]; origins?: string[] } = {}) => {
      const added = [...(request.permissions ?? []), ...(request.origins ?? [])].filter((permission) => !ext.granted.has(permission))
      for (const permission of added) ext.granted.add(permission)
      if (added.length) s.dispatch(ext.id, 'permissions.onAdded', (ctx) => [toRealm(ctx.window, request)])
      return true
    }),
    remove: env.m((request: { permissions?: string[]; origins?: string[] } = {}) => {
      for (const permission of [...(request.permissions ?? []), ...(request.origins ?? [])]) ext.granted.delete(permission)
      s.dispatch(ext.id, 'permissions.onRemoved', (ctx) => [toRealm(ctx.window, request)])
      return true
    }),
    addHostAccessRequest: env.m(() => {}, { voidResult: true }),
    removeHostAccessRequest: env.m(() => {}, { voidResult: true }),
    onAdded: env.event('permissions.onAdded'),
    onRemoved: env.event('permissions.onRemoved'),
  })
}

export function contextMenus(env: Env) {
  const { s, ext } = env
  let next = 1
  return env.obj({
    ACTION_MENU_TOP_LEVEL_LIMIT: 6,
    ContextType: Object.fromEntries(['ALL', 'PAGE', 'FRAME', 'SELECTION', 'LINK', 'EDITABLE', 'IMAGE', 'VIDEO', 'AUDIO', 'LAUNCHER', 'BROWSER_ACTION', 'PAGE_ACTION', 'ACTION'].map((type) => [type, type.toLowerCase()])),
    create: (properties: Record<string, unknown> = {}, callback?: () => void) => {
      const id = String(properties.id ?? `sticks-menu-${next++}`)
      ext.menus.set(id, { ...JSON.parse(JSON.stringify({ ...properties, onclick: undefined })), id })
      s.changed()
      if (typeof callback === 'function') setTimeout(callback, 0)
      return id
    },
    update: env.m((id: string | number, properties: Record<string, unknown>) => {
      const item = ext.menus.get(String(id))
      if (!item) throw new ApiError(`Cannot find menu item with id ${id}`)
      Object.assign(item, JSON.parse(JSON.stringify(properties)))
      s.changed()
    }, { voidResult: true }),
    remove: env.m((id: string | number) => {
      ext.menus.delete(String(id))
      s.changed()
    }, { voidResult: true }),
    removeAll: env.m(() => {
      ext.menus.clear()
      s.changed()
    }, { voidResult: true }),
    onClicked: env.event('contextMenus.onClicked'),
  })
}

export function notifications(env: Env) {
  const { s, ext } = env
  const active = new Map<string, Record<string, unknown>>()
  return env.obj({
    TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' },
    PermissionLevel: { GRANTED: 'granted', DENIED: 'denied' },
    create: env.m((a?: unknown, b?: unknown) => {
      const [id, options] = typeof a === 'string' ? [a || `sticks-${Date.now()}`, (b ?? {}) as Record<string, unknown>] : [`sticks-${Date.now()}`, (a ?? {}) as Record<string, unknown>]
      active.set(id, options)
      return s.notify(ext, id, options as { title?: string; message?: string; iconUrl?: string })
    }),
    update: env.m((id: string, options: Record<string, unknown>) => {
      if (!active.has(id)) return false
      active.set(id, { ...active.get(id), ...options })
      s.notify(ext, id, active.get(id) as { title?: string })
      return true
    }),
    clear: env.m((id: string) => {
      const had = active.delete(id)
      s.host.clearNotification?.(ext.id, id)
      return had
    }),
    getAll: env.m(() => Object.fromEntries([...active.keys()].map((id) => [id, true]))),
    getPermissionLevel: env.m(() => 'granted'),
    onClicked: env.event('notifications.onClicked'),
    onClosed: env.event('notifications.onClosed'),
    onButtonClicked: env.event('notifications.onButtonClicked'),
    onPermissionLevelChanged: env.event('notifications.onPermissionLevelChanged'),
  })
}

export function commands(env: Env) {
  const { ext } = env
  return env.obj({
    getAll: env.m(() =>
      Object.entries(ext.stored.manifest.commands ?? {}).map(([name, command]) => ({
        name,
        description: command.description ?? '',
        shortcut: command.suggested_key?.default ?? command.suggested_key?.windows ?? '',
      })),
    ),
    onCommand: env.event('commands.onCommand'),
  })
}

export function idle(env: Env) {
  return env.obj({
    IdleState: { ACTIVE: 'active', IDLE: 'idle', LOCKED: 'locked' },
    queryState: env.m(() => 'active'),
    setDetectionInterval: () => {},
    getAutoLockDelay: env.m(() => 0),
    onStateChanged: env.event('idle.onStateChanged'),
  })
}

export function management(env: Env) {
  const { s, ext } = env
  return env.obj({
    getSelf: env.m(() => s.extensionInfo(ext)),
    get: env.m((id: string) => {
      const other = s.extensions.get(id)
      if (!other) throw new ApiError(`Failed to find extension with id ${id}.`)
      return s.extensionInfo(other)
    }),
    getAll: env.m(() => [...s.extensions.values()].map((other) => s.extensionInfo(other))),
    setEnabled: env.m((id: string, enabled: boolean) => s.setEnabled(id, enabled), { voidResult: true }),
    uninstallSelf: env.m(() => s.uninstall(ext.id), { voidResult: true }),
    onInstalled: env.event('management.onInstalled'),
    onUninstalled: env.event('management.onUninstalled'),
    onEnabled: env.event('management.onEnabled'),
    onDisabled: env.event('management.onDisabled'),
  })
}

const WEB_REQUEST_EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred', 'onActionIgnored']

export function webRequest(env: Env) {
  return env.obj({
    MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
    ResourceType: Object.fromEntries(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'].map((type) => [type.toUpperCase(), type])),
    handlerBehaviorChanged: env.m(() => {}, { voidResult: true }),
    ...Object.fromEntries(WEB_REQUEST_EVENTS.map((name) => [name, env.event(`webRequest.${name}`)])),
  })
}

export function webNavigation(env: Env) {
  const { s } = env
  return env.obj({
    getFrame: env.m((details: { tabId: number; frameId: number }) => {
      const record = s.documentsOf(details.tabId, [details.frameId])[0]
      return record ? { url: record.url, parentFrameId: record.isTop ? -1 : 0, errorOccurred: false, frameId: record.frameId } : null
    }),
    getAllFrames: env.m((details: { tabId: number }) =>
      s.documentsOf(details.tabId, undefined, true).map((record) => ({ url: record.url, frameId: record.frameId, parentFrameId: record.isTop ? -1 : 0, processId: 1, errorOccurred: false })),
    ),
    ...Object.fromEntries(
      ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred', 'onCreatedNavigationTarget', 'onReferenceFragmentUpdated', 'onTabReplaced', 'onHistoryStateUpdated'].map((name) => [
        name,
        env.event(`webNavigation.${name}`),
      ]),
    ),
  })
}

export function cookies(env: Env) {
  const { s } = env
  const jar = () => {
    const found = s.controller?.cookies
    if (!found) throw new ApiError('Cookies need the STomp controller (Sticks.attach).')
    return found
  }
  const toChrome = (cookie: { name: string; value: string; domain: string; path: string; expires: string | null; secure: boolean; httpOnly: boolean; sameSite: string; hostOnly: boolean }) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain.replace(/^\./, '')}`,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite === 'none' ? 'no_restriction' : cookie.sameSite,
    hostOnly: cookie.hostOnly,
    session: cookie.expires === null,
    ...(cookie.expires ? { expirationDate: Date.parse(cookie.expires) / 1000 } : {}),
    storeId: '0',
  })
  const list = async (url?: string) => (await jar().list(url ? new URL(url).origin : undefined)).map(toChrome)
  return env.obj({
    SameSiteStatus: { NO_RESTRICTION: 'no_restriction', LAX: 'lax', STRICT: 'strict', UNSPECIFIED: 'unspecified' },
    get: env.m(async (details: { url: string; name: string }) => (await list(details.url)).find((cookie) => cookie.name === details.name) ?? null),
    getAll: env.m(async (details: { url?: string; name?: string; domain?: string } = {}) =>
      (await list(details.url)).filter((cookie) => (!details.name || cookie.name === details.name) && (!details.domain || cookie.domain.replace(/^\./, '').endsWith(details.domain.replace(/^\./, '')))),
    ),
    set: env.m(async (details: { url: string; name?: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number; sameSite?: string }) => {
      const parts = [`${details.name ?? ''}=${details.value ?? ''}`]
      if (details.domain) parts.push(`Domain=${details.domain}`)
      parts.push(`Path=${details.path ?? '/'}`)
      if (details.secure) parts.push('Secure')
      if (details.httpOnly) parts.push('HttpOnly')
      if (details.expirationDate) parts.push(`Expires=${new Date(details.expirationDate * 1000).toUTCString()}`)
      if (details.sameSite && details.sameSite !== 'unspecified') parts.push(`SameSite=${details.sameSite === 'no_restriction' ? 'None' : details.sameSite}`)
      await jar().set(details.url, parts.join('; '))
      return (await list(details.url)).find((cookie) => cookie.name === (details.name ?? '')) ?? null
    }),
    remove: env.m(async (details: { url: string; name: string }) => {
      const found = (await list(details.url)).find((cookie) => cookie.name === details.name)
      if (!found) return null
      await jar().set(details.url, `${details.name}=; Path=${found.path}; Max-Age=0${found.hostOnly ? '' : `; Domain=${found.domain}`}`)
      return { url: details.url, name: details.name, storeId: '0' }
    }),
    getAllCookieStores: env.m(() => [{ id: '0', tabIds: s.host.getTabs().map((tab) => tab.id) }]),
    onChanged: env.event('cookies.onChanged'),
  })
}

/** A ChromeSetting (privacy.*, proxy.settings): values are kept, nothing else changes. */
function setting(env: Env, key: string, fallback: unknown) {
  const { ext } = env
  return env.obj({
    get: env.m(() => ({ value: ext.settings.has(key) ? ext.settings.get(key) : fallback, levelOfControl: ext.settings.has(key) ? 'controlled_by_this_extension' : 'controllable_by_this_extension' })),
    set: env.m((details: { value: unknown }) => {
      ext.settings.set(key, JSON.parse(JSON.stringify(details?.value ?? null)))
    }, { voidResult: true }),
    clear: env.m(() => {
      ext.settings.delete(key)
    }, { voidResult: true }),
    onChange: env.event(`setting.${key}.onChange`),
  })
}

function settingGroup(env: Env, prefix: string) {
  const made = new Map<string, unknown>()
  return new Proxy(env.obj({}), {
    get(target, name) {
      if (typeof name === 'symbol') return Reflect.get(target, name)
      if (!made.has(name)) made.set(name, setting(env, `${prefix}.${name}`, prefix.endsWith('network') && name === 'webRTCIPHandlingPolicy' ? 'default' : true))
      return made.get(name)
    },
  })
}

export function privacy(env: Env) {
  return env.obj({
    network: settingGroup(env, 'privacy.network'),
    services: settingGroup(env, 'privacy.services'),
    websites: settingGroup(env, 'privacy.websites'),
    IPHandlingPolicy: { DEFAULT: 'default', DEFAULT_PUBLIC_AND_PRIVATE_INTERFACES: 'default_public_and_private_interfaces', DEFAULT_PUBLIC_INTERFACE_ONLY: 'default_public_interface_only', DISABLE_NON_PROXIED_UDP: 'disable_non_proxied_udp' },
  })
}

export function proxy(env: Env) {
  return env.obj({
    settings: setting(env, 'proxy.settings', { mode: 'system' }),
    onProxyError: env.event('proxy.onProxyError'),
  })
}

export function userScripts(env: Env) {
  const scripts = new Map<string, Record<string, unknown>>()
  return env.obj({
    ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' },
    register: env.m((list: Record<string, unknown>[]) => {
      for (const script of list) scripts.set(String(script.id), JSON.parse(JSON.stringify(script)))
    }, { voidResult: true }),
    update: env.m((list: Record<string, unknown>[]) => {
      for (const script of list) scripts.set(String(script.id), { ...scripts.get(String(script.id)), ...JSON.parse(JSON.stringify(script)) })
    }, { voidResult: true }),
    getScripts: env.m((filter?: { ids?: string[] }) => [...scripts.values()].filter((script) => !filter?.ids || filter.ids.includes(String(script.id)))),
    unregister: env.m((filter?: { ids?: string[] }) => {
      for (const id of [...scripts.keys()]) if (!filter?.ids || filter.ids.includes(id)) scripts.delete(id)
    }, { voidResult: true }),
    configureWorld: env.m(() => {}, { voidResult: true }),
    getWorldConfigurations: env.m(() => []),
    resetWorldConfiguration: env.m(() => {}, { voidResult: true }),
  })
}

export function sidePanel(env: Env) {
  return env.obj({
    setOptions: env.m(() => {}, { voidResult: true }),
    getOptions: env.m(() => ({ enabled: false })),
    setPanelBehavior: env.m(() => {}, { voidResult: true }),
    getPanelBehavior: env.m(() => ({ openPanelOnActionClick: false })),
    open: env.m(() => {
      throw new ApiError('The side panel is not supported by STicks.')
    }),
  })
}
