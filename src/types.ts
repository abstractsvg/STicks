export type Icons = Record<string, string>

export interface ManifestAction {
  default_icon?: string | Icons
  default_title?: string
  default_popup?: string
}

export interface ManifestContentScript {
  matches?: string[]
  exclude_matches?: string[]
  include_globs?: string[]
  exclude_globs?: string[]
  js?: string[]
  css?: string[]
  run_at?: RunAt
  all_frames?: boolean
  match_about_blank?: boolean
  world?: World
}

export type RunAt = 'document_start' | 'document_end' | 'document_idle'
export type World = 'ISOLATED' | 'MAIN'

export interface Manifest {
  name: string
  short_name?: string
  description?: string
  version?: string
  manifest_version?: number
  default_locale?: string
  key?: string
  icons?: Icons
  action?: ManifestAction
  browser_action?: ManifestAction
  page_action?: ManifestAction
  background?: { service_worker?: string; type?: 'module' | 'classic'; page?: string; scripts?: string[]; persistent?: boolean }
  content_scripts?: ManifestContentScript[]
  options_page?: string
  options_ui?: { page?: string; open_in_tab?: boolean }
  permissions?: string[]
  optional_permissions?: string[]
  host_permissions?: string[]
  declarative_net_request?: { rule_resources?: { id: string; enabled?: boolean; path: string }[] }
  commands?: Record<string, { description?: string; suggested_key?: Record<string, string> }>
  web_accessible_resources?: unknown
  theme?: unknown
  [key: string]: unknown
}

export interface TabInfo {
  id: number
  windowId: number
  index: number
  url: string
  title: string
  active: boolean
  status?: 'loading' | 'complete'
  favIconUrl?: string
  pinned?: boolean
  audible?: boolean
  incognito?: boolean
  highlighted?: boolean
  discarded?: boolean
  autoDiscardable?: boolean
  groupId?: number
  openerTabId?: number
}

export interface NotificationOptions {
  type?: string
  title?: string
  message?: string
  iconUrl?: string
  buttons?: { title: string }[]
  requireInteraction?: boolean
  silent?: boolean
}

/**
 * What STicks asks of the browser UI that hosts it. Only the tab lookups are
 * required; everything else makes the matching chrome.* call do something.
 */
export interface SticksHost {
  /** the tab whose STomp frame shows this window (the frame's own contentWindow) */
  getTabId(frameWindow: Window): number | null
  getTab(tabId: number): TabInfo | null
  getTabs(): TabInfo[]
  getActiveTabId(): number | null
  /** the tab's frame window, for tabs.executeScript and friends */
  getTabWindow?(tabId: number): Window | null
  /** open a tab; `url` may be an extension URL (see Sticks.isExtensionUrl) */
  createTab?(url: string, options: { active: boolean; openerTabId?: number }): number | null | Promise<number | null>
  navigateTab?(tabId: number, url: string): void
  closeTab?(tabId: number): void
  reloadTab?(tabId: number): void
  activateTab?(tabId: number): void
  goBack?(tabId: number): void
  goForward?(tabId: number): void
  /** show the extension's popup (the host then calls Sticks.mountPopup); false when it can't */
  openPopup?(extId: string, tabId: number | null): boolean
  /** window.close() inside a popup */
  closePopup?(extId: string): void
  showNotification?(extId: string, notificationId: string, options: NotificationOptions): void
  clearNotification?(extId: string, notificationId: string): void
}

export interface ExtensionSummary {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  manifest: Manifest
  iconUrl: string | null
  title: string
  badgeText: string
  badgeColor: string
  badgeTextColor: string | null
  hasPopup: boolean
  popupUrl: string | null
  optionsUrl: string | null
  actionEnabled: boolean
}

export interface StoredExtension {
  id: string
  manifest: Manifest
  enabled: boolean
  installedAt: number
  filename: string
  files: string[]
  lastRunVersion?: string
}

/** STomp's RequestRule, repeated here so STicks builds without the package */
export interface StompRule {
  match: { url?: string; method?: string[]; destination?: string[]; site?: ('same-origin' | 'same-site' | 'cross-site' | 'none')[] }
  action: 'block' | { requestHeaders?: Record<string, string | null>; responseHeaders?: Record<string, string | null>; redirect?: string; status?: number }
}

/** STomp's HookContext, the argument its init hooks receive */
export interface StompHookContext {
  url: string
  origin: string
  isTop: boolean
  nested: boolean
  kind: 'document' | 'worker' | 'sharedWorker'
  phase: 'pre' | 'post'
  frameId?: string
  window: typeof globalThis
}

/** STomp's request report (init.onRequest) */
export interface StompRequestInfo {
  url: string
  method: string
  destination: string
  status: number
  error?: string
  ms?: number
  frame?: { element?: HTMLIFrameElement } | null
}

/** STomp's navigate report (init.onNavigate) */
export interface StompNavigateInfo {
  url: string
  title: string
  icon?: string | null
}

/** The part of StompController STicks uses */
export interface StompControllerLike {
  route(url: string): Promise<string> | string
  setRules?(rules: StompRule[]): unknown
  cookies?: {
    get(url: string): Promise<string>
    set(url: string, setCookie: string | string[]): Promise<void>
    list(origin?: string): Promise<StompCookie[]>
    clear(origin?: string): Promise<void>
  }
}

export interface StompCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: string | null
  secure: boolean
  httpOnly: boolean
  sameSite: 'lax' | 'strict' | 'none'
  hostOnly: boolean
}
