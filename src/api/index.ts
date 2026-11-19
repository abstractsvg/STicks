import type { Context } from '../context.ts'
import type { Sticks } from '../sticks.ts'
import { action } from './action.ts'
import { declarativeNetRequest } from './dnr.ts'
import { makeEnv, stubNamespace } from './env.ts'
import {
  alarms,
  commands,
  contextMenus,
  cookies,
  idle,
  management,
  notifications,
  offscreen,
  permissions,
  privacy,
  proxy,
  sidePanel,
  userScripts,
  webNavigation,
  webRequest,
} from './misc.ts'
import { dom, extension, i18n, runtime } from './runtime.ts'
import { storage } from './storage.ts'
import { scripting, tabs, windows } from './tabs.ts'

/** The chrome object one context sees: content scripts get Chrome's content-script subset. */
export function buildChrome(s: Sticks, ctx: Context): Record<string, unknown> {
  const env = makeEnv(s, ctx)
  const manifest = ctx.ext.stored.manifest
  const chrome: Record<string, unknown> = {
    runtime: runtime(env),
    storage: storage(env),
    i18n: i18n(env),
    extension: extension(env),
    dom: dom(env),
  }
  if (ctx.kind === 'content') return env.obj(chrome)

  const mv3 = Number(manifest.manifest_version) >= 3
  Object.assign(chrome, {
    tabs: tabs(env),
    windows: windows(env),
    alarms: alarms(env),
    permissions: permissions(env),
    contextMenus: contextMenus(env),
    notifications: notifications(env),
    commands: commands(env),
    idle: idle(env),
    management: management(env),
    webRequest: webRequest(env),
    webNavigation: webNavigation(env),
    cookies: cookies(env),
    privacy: privacy(env),
    proxy: proxy(env),
    declarativeNetRequest: declarativeNetRequest(env),
  })
  if (mv3) {
    Object.assign(chrome, {
      action: action(env, 'action'),
      scripting: scripting(env),
      offscreen: offscreen(env),
      userScripts: userScripts(env),
      sidePanel: sidePanel(env),
    })
  } else {
    chrome.browserAction = action(env, 'browserAction')
    if (manifest.page_action) chrome.pageAction = action(env, 'pageAction')
  }
  for (const permission of ctx.ext.granted) {
    const name = permission.split('.')[0]
    if (/^[a-z][a-zA-Z]+$/.test(name) && !(name in chrome) && !NOT_NAMESPACES.has(name)) chrome[name] = stubNamespace(env, name)
  }
  return env.obj(chrome)
}

const NOT_NAMESPACES = new Set([
  'activeTab',
  'background',
  'clipboardRead',
  'clipboardWrite',
  'declarativeNetRequestFeedback',
  'declarativeNetRequestWithHostAccess',
  'geolocation',
  'unlimitedStorage',
  'webRequestBlocking',
  'webRequestAuthProvider',
])
