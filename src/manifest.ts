import type { Manifest } from './types.ts'

/** JSON as extension authors write it: comments, trailing commas and a BOM are allowed. */
export function parseLooseJson(text: string): unknown {
  let out = ''
  let inString = false
  for (let at = text.charCodeAt(0) === 0xfeff ? 1 : 0; at < text.length; at++) {
    const char = text[at]
    if (inString) {
      out += char
      if (char === '\\') out += text[++at] ?? ''
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[at + 1] === '/') {
      while (at < text.length && text[at] !== '\n') at++
      out += '\n'
    } else if (char === '/' && text[at + 1] === '*') {
      at = text.indexOf('*/', at + 2)
      if (at < 0) break
      at++
    } else if (char === ',' && /^\s*[}\]]/.test(text.slice(at + 1, at + 200))) {
      continue
    } else {
      out += char
    }
  }
  return JSON.parse(out)
}

export function parseManifest(text: string): Manifest {
  const value = parseLooseJson(text)
  if (!value || typeof value !== 'object' || typeof (value as Manifest).name !== 'string') {
    throw new Error('manifest.json has no name')
  }
  return value as Manifest
}

type Message = { message: string; placeholders?: Record<string, { content: string }> }
export type Messages = Record<string, Message>

export function normalizeMessages(raw: unknown): Messages {
  const out: Messages = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, Message>)) {
    if (value && typeof value.message === 'string') out[key.toLowerCase()] = value
  }
  return out
}

/** The locales to try, most specific first: the browser's language, its base, the default. */
export function localeChain(defaultLocale: string | undefined, language = typeof navigator === 'undefined' ? 'en' : navigator.language) {
  const ui = language.replace('-', '_')
  const chain = [ui, ui.split('_')[0]]
  if (defaultLocale) chain.push(defaultLocale)
  return [...new Set(chain)]
}

export function getMessage(
  catalogs: Messages[],
  name: string,
  substitutions: unknown,
  special: Record<string, string>,
): string {
  const key = String(name)
  if (key.startsWith('@@')) return special[key.toLowerCase()] ?? ''
  const entry = catalogs.map((catalog) => catalog[key.toLowerCase()]).find(Boolean)
  if (!entry) return ''
  const subs = (Array.isArray(substitutions) ? substitutions : substitutions === undefined ? [] : [substitutions]).map(String)
  const fill = (text: string) => text.replace(/\$(\d)/g, (_, digit: string) => subs[Number(digit) - 1] ?? '')
  const placeholders = Object.fromEntries(
    Object.entries(entry.placeholders ?? {}).map(([placeholder, value]) => [placeholder.toLowerCase(), fill(value.content ?? '')]),
  )
  return entry.message
    .replace(/\$([a-zA-Z0-9_@]+)\$/g, (whole, placeholder: string) => placeholders[placeholder.toLowerCase()] ?? whole)
    .replace(/\$(\d)/g, (_, digit: string) => subs[Number(digit) - 1] ?? '')
    .replace(/\$\$/g, '$')
}

/** Replaces __MSG_name__ in manifest strings and CSS. */
export function localize(text: string, catalogs: Messages[], special: Record<string, string>) {
  return text.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (whole, name: string) => getMessage(catalogs, name, undefined, special) || whole)
}
