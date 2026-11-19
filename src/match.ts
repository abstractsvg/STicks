const SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'file']

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

const cache = new Map<string, RegExp | null>()

/** A match pattern (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) as a RegExp. */
export function patternToRegExp(pattern: string): RegExp | null {
  const hit = cache.get(pattern)
  if (hit !== undefined) return hit
  let result: RegExp | null = null
  if (pattern === '<all_urls>') {
    result = /^(https?|wss?|ftp|file):\/\//
  } else {
    const parts = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)?$/.exec(pattern)
    if (parts && (parts[1] === '*' || SCHEMES.includes(parts[1]))) {
      const scheme = parts[1] === '*' ? 'https?|wss?' : escape(parts[1])
      const host = parts[2]
      let hostRe: string
      if (host === '*') hostRe = '[^/]*'
      else if (host.startsWith('*.')) hostRe = `(?:[^/]*\\.)?${escape(host.slice(2))}(?::\\d+)?`
      else hostRe = `${escape(host)}(?::\\d+)?`
      const path = (parts[3] ?? '/').split('*').map(escape).join('.*')
      result = new RegExp(`^(?:${scheme}):\\/\\/${hostRe}${path}$`)
    }
  }
  cache.set(pattern, result)
  return result
}

export function matchesPattern(pattern: string, url: string) {
  const re = patternToRegExp(pattern)
  if (!re) return false
  if (pattern === '<all_urls>') return re.test(url)
  try {
    const parsed = new URL(url)
    const bare = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`
    return re.test(bare)
  } catch {
    return false
  }
}

export function matchesAny(patterns: string[] | undefined, url: string) {
  return !!patterns?.some((pattern) => matchesPattern(pattern, url))
}

function globToRegExp(glob: string) {
  return new RegExp(`^${glob.split('').map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escape(char))).join('')}$`)
}

export function matchesGlobs(include: string[] | undefined, exclude: string[] | undefined, url: string) {
  if (include?.length && !include.some((glob) => globToRegExp(glob).test(url))) return false
  if (exclude?.some((glob) => globToRegExp(glob).test(url))) return false
  return true
}

/** Whether a content-script registration runs on this URL. */
export function scriptMatches(
  registration: { matches?: string[]; exclude_matches?: string[]; include_globs?: string[]; exclude_globs?: string[] },
  url: string,
) {
  return (
    matchesAny(registration.matches, url) &&
    !matchesAny(registration.exclude_matches, url) &&
    matchesGlobs(registration.include_globs, registration.exclude_globs, url)
  )
}
