import { ChromeEvent } from './events.ts'
import type { Messages } from './manifest.ts'
import type { Realm } from './realm.ts'
import type { Manifest, StoredExtension } from './types.ts'

export type ContextKind = 'background' | 'popup' | 'page' | 'offscreen' | 'content'

export interface ActionState {
  title: string | null
  iconUrl: string | null
  popup: string | null
  badgeText: string
  badgeColor: string
  badgeTextColor: string | null
  enabled: boolean
}

export interface DnrRule {
  id: number
  priority?: number
  condition: Record<string, unknown>
  action: { type: string; redirect?: { url?: string; extensionPath?: string }; requestHeaders?: { header: string; operation: string; value?: string }[]; responseHeaders?: { header: string; operation: string; value?: string }[] }
}

export interface ContentRegistration {
  id?: string
  source: 'manifest' | 'scripting'
  matches: string[]
  exclude_matches?: string[]
  include_globs?: string[]
  exclude_globs?: string[]
  js: string[]
  css: string[]
  run_at: 'document_start' | 'document_end' | 'document_idle'
  all_frames: boolean
  world: 'ISOLATED' | 'MAIN'
  persistAcrossSessions?: boolean
}

export interface Extension {
  id: string
  manifest: Manifest
  stored: StoredExtension
  enabled: boolean
  catalogs: Messages[]
  /** source text of every file a content script needs, read once at load */
  sources: Map<string, string>
  storage: Record<'local' | 'sync' | 'session' | 'managed', Record<string, unknown>>
  action: ActionState
  tabAction: Map<number, Partial<ActionState>>
  alarms: Map<string, { name: string; scheduledTime: number; periodInMinutes?: number; timer: ReturnType<typeof setTimeout> }>
  dnr: { dynamic: DnrRule[]; session: DnrRule[]; enabled: Set<string>; rulesets: Map<string, DnrRule[]> }
  registered: ContentRegistration[]
  background: HTMLIFrameElement | null
  offscreen: HTMLIFrameElement | null
  menus: Map<string, Record<string, unknown>>
  settings: Map<string, unknown>
  granted: Set<string>
}

export interface Context {
  id: number
  ext: Extension
  kind: ContextKind
  window: Realm
  tabId: number | null
  frameId: number
  url: string
  alive: boolean
  lastError: { message: string } | undefined
  lastErrorChecked: boolean
  events: Map<string, ChromeEvent>
  disposers: (() => void)[]
}

let nextContextId = 1

export function createContext(init: Omit<Context, 'id' | 'alive' | 'lastError' | 'lastErrorChecked' | 'events' | 'disposers'>): Context {
  return { ...init, id: nextContextId++, alive: true, lastError: undefined, lastErrorChecked: false, events: new Map(), disposers: [] }
}

export function eventOf(ctx: Context, name: string) {
  let event = ctx.events.get(name)
  if (!event) {
    event = new ChromeEvent(ctx, name)
    ctx.events.set(name, event)
  }
  return event
}
