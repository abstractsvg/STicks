import { deliverMessage, NO_RECEIVER, openPort } from '../messaging.ts'
import { ApiError, raw } from '../realm.ts'
import type { Env } from './env.ts'

const EXTENSION_ID = /^[a-p]{32}$/

/** runtime.sendMessage's overloads, once method() took the callback off. */
function messageArgs(args: unknown[]): { target: string | null; message: unknown } {
  if (args.length >= 3) return { target: (args[0] as string) ?? null, message: args[1] }
  if (args.length === 2 && typeof args[0] === 'string' && EXTENSION_ID.test(args[0])) return { target: args[0], message: args[1] }
  return { target: null, message: args[0] }
}

function platformInfo() {
  const agent = navigator.userAgent
  const os = /Windows/.test(agent) ? 'win' : /Mac OS X/.test(agent) ? 'mac' : /CrOS/.test(agent) ? 'cros' : /Android/.test(agent) ? 'android' : 'linux'
  const arch = /arm|aarch64/i.test(agent) ? 'arm64' : 'x86-64'
  return { os, arch, nacl_arch: arch }
}

export function runtime(env: Env) {
  const { s, ctx, ext } = env
  const content = ctx.kind === 'content'

  const sendMessage = env.m(async (...args: unknown[]) => {
    const { target, message } = messageArgs(args)
    const targetId = target ?? ext.id
    const targetExt = s.extensions.get(targetId)
    if (!targetExt?.enabled) throw new ApiError(NO_RECEIVER)
    const external = targetId !== ext.id
    const receivers = () => s.contextsOf(targetId, (other) => other !== ctx && other.kind !== 'content')
    if (!receivers().some((other) => other.kind === 'background')) await s.backgroundReady(targetExt)
    return deliverMessage(receivers(), external ? 'runtime.onMessageExternal' : 'runtime.onMessage', message, s.sender(ctx))
  })

  const connect = (...args: unknown[]) => {
    const target = typeof args[0] === 'string' ? (args.shift() as string) : ext.id
    const info = (args[0] ?? {}) as { name?: string }
    const targetExt = s.extensions.get(target)
    const event = target === ext.id ? 'runtime.onConnect' : 'runtime.onConnectExternal'
    return openPort(
      ctx,
      () => s.contextsOf(target, (other) => other !== ctx && other.kind !== 'content'),
      event,
      String(info.name ?? ''),
      s.sender(ctx),
      targetExt ? s.backgroundReady(targetExt) : Promise.resolve(),
    )
  }

  const api: Record<string, unknown> = {
    id: ext.id,
    getURL: env.sync((path: unknown) => s.extensionUrl(ext.id, String(path ?? ''))),
    getManifest: env.sync(() => ext.stored.manifest),
    sendMessage,
    connect,
    onMessage: env.event('runtime.onMessage'),
    onConnect: env.event('runtime.onConnect'),
    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
    ContextType: { TAB: 'TAB', POPUP: 'POPUP', BACKGROUND: 'BACKGROUND', OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL' },
    PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd', FUCHSIA: 'fuchsia' },
  }

  if (!content) {
    Object.assign(api, {
      onInstalled: env.event('runtime.onInstalled'),
      onStartup: env.event('runtime.onStartup'),
      onSuspend: env.event('runtime.onSuspend'),
      onSuspendCanceled: env.event('runtime.onSuspendCanceled'),
      onUpdateAvailable: env.event('runtime.onUpdateAvailable'),
      onRestartRequired: env.event('runtime.onRestartRequired'),
      onMessageExternal: env.event('runtime.onMessageExternal'),
      onConnectExternal: env.event('runtime.onConnectExternal'),
      onUserScriptMessage: env.event('runtime.onUserScriptMessage'),
      onUserScriptConnect: env.event('runtime.onUserScriptConnect'),
      getPlatformInfo: env.m(() => platformInfo()),
      getBackgroundPage: env.m(() => raw(ext.background?.contentWindow ?? null)),
      openOptionsPage: env.m(async () => {
        const page = ext.manifest.options_ui?.page ?? ext.manifest.options_page
        if (!page) throw new ApiError('Could not create an options page.')
        await s.createTab(s.extensionUrl(ext.id, page), true)
      }, { voidResult: true }),
      setUninstallURL: env.m((url: unknown) => {
        ext.settings.set('uninstallUrl', String(url ?? ''))
      }, { voidResult: true }),
      reload: () => {
        try {
          ext.background?.contentWindow?.location.reload()
        } catch {
          return
        }
      },
      requestUpdateCheck: env.m(() => ({ status: 'no_update' })),
      restart: () => {},
      restartAfterDelay: env.m(() => {}, { voidResult: true }),
      getContexts: env.m((filter: { contextTypes?: string[] } = {}) => {
        const types: Record<string, string> = { background: 'BACKGROUND', popup: 'POPUP', page: 'TAB', offscreen: 'OFFSCREEN_DOCUMENT' }
        return s
          .contextsOf(ext.id, (other) => other.kind !== 'content')
          .map((other) => ({
            contextType: types[other.kind],
            contextId: String(other.id),
            tabId: other.tabId ?? -1,
            windowId: 1,
            frameId: 0,
            documentUrl: s.displayUrl(other.url),
            documentOrigin: `chrome-extension://${ext.id}`,
            incognito: false,
          }))
          .filter((info) => !filter.contextTypes || filter.contextTypes.includes(info.contextType))
      }),
    })
  }

  const object = env.obj(api)
  Object.defineProperty(object, 'lastError', {
    enumerable: true,
    get: () => {
      ctx.lastErrorChecked = true
      return ctx.lastError
    },
  })
  return object
}

export function extension(env: Env) {
  const { s, ctx, ext } = env
  const api = env.obj({
    getURL: env.sync((path: unknown) => s.extensionUrl(ext.id, String(path ?? ''))),
    inIncognitoContext: false,
    getBackgroundPage: () => ext.background?.contentWindow ?? null,
    getViews: (filter: { type?: string; tabId?: number } = {}) => {
      const types: Record<string, string> = { popup: 'popup', page: 'tab', background: 'background', offscreen: 'offscreen' }
      return new ctx.window.Array(
        ...s
          .contextsOf(ext.id, (other) => other.kind !== 'content')
          .filter((other) => (!filter.type || types[other.kind] === filter.type) && (filter.tabId === undefined || other.tabId === filter.tabId))
          .map((other) => other.window),
      )
    },
    isAllowedIncognitoAccess: env.m(() => false),
    isAllowedFileSchemeAccess: env.m(() => false),
    setUpdateUrlData: () => {},
  })
  Object.defineProperty(api, 'lastError', { enumerable: true, get: () => ctx.lastError })
  return api
}

export function i18n(env: Env) {
  const { s, ext } = env
  return env.obj({
    getMessage: env.sync((name: unknown, substitutions: unknown) => s.message(ext, String(name), substitutions)),
    getUILanguage: env.sync(() => navigator.language || 'en-US'),
    getAcceptLanguages: env.m(() => [...(navigator.languages ?? ['en-US'])]),
    detectLanguage: env.m(() => ({ isReliable: false, languages: [] })),
  })
}

export function dom(env: Env) {
  return env.obj({
    openOrClosedShadowRoot: (element: Element) => element?.shadowRoot ?? null,
  })
}
