import type { ActionState } from '../context.ts'
import { ApiError } from '../realm.ts'
import type { Env } from './env.ts'

type Details = { tabId?: number | null } | undefined
type ColorInput = string | number[]

const NAMED: Record<string, string> = { red: '#ff0000', green: '#008000', blue: '#0000ff', black: '#000000', white: '#ffffff', transparent: 'rgba(0,0,0,0)' }

function toCss(color: ColorInput): string {
  if (Array.isArray(color)) {
    const [r = 0, g = 0, b = 0, a = 255] = color.map(Number)
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`
  }
  const text = String(color).trim().toLowerCase()
  if (NAMED[text]) return NAMED[text]
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text) || /^rgba?\(/.test(text)) return text
  throw new ApiError('The color specification could not be parsed.')
}

function toArray(css: string | null): number[] {
  if (!css) return [0, 0, 0, 0]
  const hex = /^#([0-9a-f]+)$/i.exec(css)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? hex.split('').map((char) => char + char).join('') : hex
    const value = (at: number) => parseInt(full.slice(at, at + 2), 16)
    return [value(0), value(2), value(4), full.length === 8 ? value(6) : 255]
  }
  const parts = /rgba?\(([^)]+)\)/.exec(css)?.[1].split(/[,\s/]+/).filter(Boolean).map(Number) ?? []
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] === undefined ? 255 : Math.round(parts[3] * 255)]
}

function imageDataUrl(data: { width: number; height: number; data: ArrayLike<number> }) {
  const canvas = document.createElement('canvas')
  canvas.width = data.width
  canvas.height = data.height
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(data.data), data.width, data.height), 0, 0)
  return canvas.toDataURL('image/png')
}

function pick<T>(value: T | Record<string, T>): T | undefined {
  if (!value || typeof value !== 'object' || 'width' in (value as object)) return value as T
  const entries = Object.entries(value as Record<string, T>).sort((a, b) => Number(a[0]) - Number(b[0]))
  return (entries.find(([size]) => Number(size) >= 32) ?? entries[entries.length - 1])?.[1]
}

export function action(env: Env, kind: 'action' | 'browserAction' | 'pageAction') {
  const { s, ext } = env

  const set = (details: Details, patch: Partial<ActionState>) => {
    const tabId = details?.tabId
    if (tabId !== undefined && tabId !== null) {
      if (!s.tab(tabId)) throw new ApiError(`No tab with id: ${tabId}.`)
      ext.tabAction.set(tabId, { ...ext.tabAction.get(tabId), ...patch })
    } else {
      Object.assign(ext.action, patch)
    }
    s.changed()
  }
  const get = <K extends keyof ActionState>(details: Details, key: K) => s.actionState(ext, details?.tabId ?? null)[key]
  const tabArg = (value: unknown): Details => (typeof value === 'number' ? { tabId: value } : undefined)

  return env.obj({
    setBadgeText: env.m((details: Details & { text?: string | null }) => set(details, { badgeText: String(details?.text ?? '') }), { voidResult: true }),
    getBadgeText: env.m((details: Details) => get(details, 'badgeText')),
    setBadgeBackgroundColor: env.m((details: Details & { color: ColorInput }) => set(details, { badgeColor: toCss(details.color) }), { voidResult: true }),
    getBadgeBackgroundColor: env.m((details: Details) => toArray(get(details, 'badgeColor'))),
    setBadgeTextColor: env.m((details: Details & { color: ColorInput }) => set(details, { badgeTextColor: toCss(details.color) }), { voidResult: true }),
    getBadgeTextColor: env.m((details: Details) => toArray(get(details, 'badgeTextColor'))),
    setTitle: env.m((details: Details & { title: string }) => set(details, { title: String(details.title ?? '') }), { voidResult: true }),
    getTitle: env.m((details: Details) => get(details, 'title') ?? ext.manifest.name),
    setIcon: env.m((details: Details & { path?: string | Record<string, string>; imageData?: unknown }) => {
      let iconUrl: string | null = null
      if (details.imageData) {
        const data = pick(details.imageData as Record<string, { width: number; height: number; data: ArrayLike<number> }>)
        if (data) iconUrl = imageDataUrl(data)
      } else if (details.path) {
        const path = pick(details.path)
        if (path) iconUrl = /^(data|blob|https?):/.test(path) ? path : s.extensionUrl(ext.id, path)
      }
      if (!iconUrl) throw new ApiError('Either path or imageData must be specified.')
      set(details, { iconUrl })
    }, { voidResult: true }),
    setPopup: env.m((details: Details & { popup: string }) => {
      const popup = String(details.popup ?? '')
      set(details, { popup: popup ? popup.replace(new RegExp(`^.*?/ext/${ext.id}/`), '').replace(/^chrome-extension:\/\/[a-p]{32}\//, '') : null })
    }, { voidResult: true }),
    getPopup: env.m((details: Details) => {
      const popup = get(details, 'popup')
      return popup ? s.extensionUrl(ext.id, popup) : ''
    }),
    enable: env.m((tabId?: number) => set(tabArg(tabId), { enabled: true }), { voidResult: true }),
    disable: env.m((tabId?: number) => set(tabArg(tabId), { enabled: false }), { voidResult: true }),
    isEnabled: env.m((tabId?: number) => get(tabArg(tabId), 'enabled')),
    show: env.m((tabId?: number) => set(tabArg(tabId), { enabled: true }), { voidResult: true }),
    hide: env.m((tabId?: number) => set(tabArg(tabId), { enabled: false }), { voidResult: true }),
    openPopup: env.m(() => {
      const tabId = s.host.getActiveTabId()
      if (!s.actionState(ext, tabId).popup || !s.host.openPopup?.(ext.id, tabId)) throw new ApiError('Could not find an active browser window.')
    }, { voidResult: true }),
    getUserSettings: env.m(() => ({ isOnToolbar: true })),
    onClicked: env.event(`${kind}.onClicked`),
    onUserSettingsChanged: env.event(`${kind}.onUserSettingsChanged`),
  })
}
