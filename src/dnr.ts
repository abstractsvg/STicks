import type { DnrRule } from './context.ts'
import type { StompRule } from './types.ts'

const ALL_DESTINATIONS = [
  'document',
  'iframe',
  'frame',
  'style',
  'script',
  'image',
  'font',
  'object',
  'embed',
  'fetch',
  'audio',
  'video',
  'track',
  'worker',
  'sharedworker',
  'manifest',
  'report',
  'xslt',
]

const DESTINATIONS: Record<string, string[]> = {
  main_frame: ['document'],
  sub_frame: ['iframe', 'frame'],
  stylesheet: ['style'],
  script: ['script'],
  image: ['image'],
  font: ['font'],
  object: ['object', 'embed'],
  xmlhttprequest: ['fetch'],
  ping: ['fetch'],
  csp_report: ['report'],
  media: ['audio', 'video', 'track'],
  other: ['manifest', 'xslt', 'worker', 'sharedworker'],
}

const ACTION_ORDER: Record<string, number> = { allow: 0, allowAllRequests: 1, block: 2, upgradeScheme: 3, redirect: 4, modifyHeaders: 5 }
const DOMAIN_CHUNK = 800
const hostRegExp = (host: string) => host.toLowerCase().replace(/\./g, '\\.')

export interface CompileStats {
  total: number
  compiled: number
  skipped: number
  truncated: number
}

function destinations(condition: Record<string, unknown>): string[] | null {
  const included = condition.resourceTypes as string[] | undefined
  const excluded = condition.excludedResourceTypes as string[] | undefined
  if (included?.length) {
    const list = [...new Set(included.flatMap((type) => DESTINATIONS[type] ?? []))]
    return list.length ? list : null
  }
  const removed = new Set((excluded ?? ['main_frame']).flatMap((type) => DESTINATIONS[type] ?? []))
  return ALL_DESTINATIONS.filter((destination) => !removed.has(destination))
}

/** `||ads.example.com^/path` style filters, and |-anchored URLs; null for what URLPattern can't say. */
function urlFilterPatterns(filter: string): string[] | null {
  if (filter.startsWith('||')) {
    const body = filter.slice(2)
    const cut = body.search(/[\^/*|]/)
    const host = cut < 0 ? body : body.slice(0, cut)
    let rest = cut < 0 ? '' : body.slice(cut)
    if (!/^[a-z0-9.-]+$/i.test(host)) return null
    rest = rest.replace(/^\^/, '/').replace(/\|$/, '')
    if (rest && !/^[\w/.\-*^=?&%]*$/.test(rest)) return null
    const path = (rest.startsWith('/') ? rest : `/${rest}`).replace(/\^/g, '*').split('?')[0]
    const pathname = path.endsWith('*') ? path : `${path}*`
    return [`*://((?:.*\\.)?${hostRegExp(host)})${pathname}`]
  }
  if (filter.startsWith('|') && /^\|https?:\/\/[a-z0-9.-]+\/[\w/.\-*^]*\|?$/i.test(filter)) {
    const url = filter.slice(1).replace(/\|$/, '').replace(/\^/g, '*')
    return [url.endsWith('*') ? url : `${url}*`]
  }
  if (!filter.startsWith('|') && filter.includes('/') && /^[\w/.\-*]+$/.test(filter)) {
    const part = filter.replace(/^\*+|\*+$/g, '')
    return part.startsWith('/') ? [`*://*${part}*`, `*://*/*${part}*`] : [`*://*/*${part}*`]
  }
  return null
}

function domainPatterns(domains: string[]): string[] {
  const clean = domains.filter((domain) => /^[a-z0-9.-]+$/i.test(domain)).map(hostRegExp)
  const patterns: string[] = []
  for (let at = 0; at < clean.length; at += DOMAIN_CHUNK) {
    patterns.push(`*://((?:.*\\.)?(?:${clean.slice(at, at + DOMAIN_CHUNK).join('|')}))/*`)
  }
  return patterns
}

function action(rule: DnrRule): StompRule['action'] | null {
  const { type } = rule.action
  if (type === 'block') return 'block'
  if (type === 'allow' || type === 'allowAllRequests') return {}
  if (type === 'redirect') return rule.action.redirect?.url ? { redirect: rule.action.redirect.url } : null
  if (type === 'modifyHeaders') {
    const map = (list: { header: string; operation: string; value?: string }[] | undefined) => {
      if (!list?.length) return undefined
      const out: Record<string, string | null> = {}
      for (const header of list) {
        if (header.operation === 'remove') out[header.header] = null
        else if (header.operation === 'set' && typeof header.value === 'string') out[header.header] = header.value
      }
      return Object.keys(out).length ? out : undefined
    }
    const requestHeaders = map(rule.action.requestHeaders)
    const responseHeaders = map(rule.action.responseHeaders)
    return requestHeaders || responseHeaders ? { requestHeaders, responseHeaders } : null
  }
  return null
}

const UNSUPPORTED = ['regexFilter', 'initiatorDomains', 'excludedInitiatorDomains', 'domains', 'excludedDomains', 'excludedRequestDomains', 'tabIds', 'excludedTabIds', 'responseHeaders', 'excludedResponseHeaders']

/** One DNR rule as STomp rules (several when it lists many domains), or null when it can't be expressed. */
export function compileRule(rule: DnrRule): StompRule[] | null {
  const condition = rule.condition ?? {}
  if (UNSUPPORTED.some((key) => condition[key] !== undefined && !(Array.isArray(condition[key]) && !(condition[key] as unknown[]).length))) return null
  const act = action(rule)
  if (!act) return null
  const where = destinations(condition)
  if (!where) return null
  let patterns: string[] | null
  const requestDomains = condition.requestDomains as string[] | undefined
  const urlFilter = condition.urlFilter as string | undefined
  if (requestDomains?.length && urlFilter) return null
  if (requestDomains?.length) patterns = domainPatterns(requestDomains)
  else if (urlFilter) patterns = urlFilterPatterns(urlFilter)
  else patterns = ['*://*/*']
  if (!patterns?.length) return null
  const methods = condition.requestMethods as string[] | undefined
  const site =
    condition.domainType === 'firstParty'
      ? (['same-origin', 'same-site'] as const)
      : condition.domainType === 'thirdParty'
        ? (['cross-site'] as const)
        : undefined
  return patterns.map((url) => ({
    match: {
      url,
      destination: where,
      ...(methods?.length ? { method: methods.map((verb) => verb.toUpperCase()) } : {}),
      ...(site ? { site: [...site] } : {}),
    },
    action: act,
  }))
}

/** Every enabled rule of every extension as STomp's first-match-wins list, capped at `max`. */
export function compileRules(rules: DnrRule[], max: number): { rules: StompRule[]; stats: CompileStats } {
  const ordered = [...rules].sort(
    (a, b) => (b.priority ?? 1) - (a.priority ?? 1) || (ACTION_ORDER[a.action.type] ?? 9) - (ACTION_ORDER[b.action.type] ?? 9),
  )
  const out: StompRule[] = []
  const stats: CompileStats = { total: rules.length, compiled: 0, skipped: 0, truncated: 0 }
  for (const rule of ordered) {
    const compiled = compileRule(rule)
    if (!compiled) {
      stats.skipped++
      continue
    }
    if (out.length + compiled.length > max) {
      stats.truncated++
      continue
    }
    out.push(...compiled)
    stats.compiled++
  }
  return { rules: out, stats }
}
