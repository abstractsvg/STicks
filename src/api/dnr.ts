import type { DnrRule } from '../context.ts'
import { ApiError } from '../realm.ts'
import type { Env } from './env.ts'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T

export function declarativeNetRequest(env: Env) {
  const { s, ext } = env
  const update = (list: DnrRule[], removeIds: number[] = [], add: DnrRule[] = []) => {
    const removed = new Set(removeIds)
    const next = list.filter((rule) => !removed.has(rule.id))
    for (const rule of add) {
      if (typeof rule?.id !== 'number' || !rule.action || !rule.condition) throw new ApiError('Rule is missing an id, action or condition.')
      if (next.some((existing) => existing.id === rule.id)) throw new ApiError(`Rule with id ${rule.id} does not have a unique ID.`)
      next.push(copy(rule))
    }
    return next
  }
  const byIds = (list: DnrRule[], filter?: { ruleIds?: number[] }) => (filter?.ruleIds ? list.filter((rule) => filter.ruleIds!.includes(rule.id)) : list)

  return env.obj({
    MAX_NUMBER_OF_RULES: 330_000,
    GUARANTEED_MINIMUM_STATIC_RULES: 30_000,
    MAX_NUMBER_OF_DYNAMIC_RULES: 30_000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
    MAX_NUMBER_OF_SESSION_RULES: 5000,
    MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    MAX_NUMBER_OF_STATIC_RULESETS: 100,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
    MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
    GETMATCHEDRULES_QUOTA_INTERVAL: 10,
    DYNAMIC_RULESET_ID: '_dynamic',
    SESSION_RULESET_ID: '_session',
    RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow', UPGRADE_SCHEME: 'upgradeScheme', MODIFY_HEADERS: 'modifyHeaders', ALLOW_ALL_REQUESTS: 'allowAllRequests' },
    ResourceType: {
      MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame', STYLESHEET: 'stylesheet', SCRIPT: 'script', IMAGE: 'image', FONT: 'font', OBJECT: 'object',
      XMLHTTPREQUEST: 'xmlhttprequest', PING: 'ping', CSP_REPORT: 'csp_report', MEDIA: 'media', WEBSOCKET: 'websocket', WEBTRANSPORT: 'webtransport', WEBBUNDLE: 'webbundle', OTHER: 'other',
    },
    DomainType: { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' },
    HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' },
    RequestMethod: { CONNECT: 'connect', DELETE: 'delete', GET: 'get', HEAD: 'head', OPTIONS: 'options', PATCH: 'patch', POST: 'post', PUT: 'put', OTHER: 'other' },
    UnsupportedRegexReason: { SYNTAX_ERROR: 'syntaxError', MEMORY_LIMIT_EXCEEDED: 'memoryLimitExceeded' },
    updateDynamicRules: env.m((options: { removeRuleIds?: number[]; addRules?: DnrRule[] } = {}) => {
      ext.dnr.dynamic = update(ext.dnr.dynamic, options.removeRuleIds, options.addRules)
      s.saveState(ext, 'dynamicRules', ext.dnr.dynamic)
      s.applyRules()
    }, { voidResult: true }),
    getDynamicRules: env.m((filter?: { ruleIds?: number[] }) => byIds(ext.dnr.dynamic, filter)),
    updateSessionRules: env.m((options: { removeRuleIds?: number[]; addRules?: DnrRule[] } = {}) => {
      ext.dnr.session = update(ext.dnr.session, options.removeRuleIds, options.addRules)
      s.applyRules()
    }, { voidResult: true }),
    getSessionRules: env.m((filter?: { ruleIds?: number[] }) => byIds(ext.dnr.session, filter)),
    updateEnabledRulesets: env.m(async (options: { enableRulesetIds?: string[]; disableRulesetIds?: string[] } = {}) => {
      for (const id of options.disableRulesetIds ?? []) ext.dnr.enabled.delete(id)
      for (const id of options.enableRulesetIds ?? []) {
        if (!(await s.loadRuleset(ext, id))) throw new ApiError(`Invalid ruleset id: ${id}.`)
        ext.dnr.enabled.add(id)
      }
      s.saveState(ext, 'rulesets', [...ext.dnr.enabled])
      s.applyRules()
    }, { voidResult: true }),
    getEnabledRulesets: env.m(() => [...ext.dnr.enabled]),
    updateStaticRules: env.m(() => {}, { voidResult: true }),
    getDisabledRuleIds: env.m(() => []),
    getAvailableStaticRuleCount: env.m(() => {
      let used = 0
      for (const id of ext.dnr.enabled) used += ext.dnr.rulesets.get(id)?.length ?? 0
      return Math.max(0, 330_000 - used)
    }),
    isRegexSupported: env.m(() => ({ isSupported: true })),
    getMatchedRules: env.m(() => ({ rulesMatchedInfo: [] })),
    testMatchOutcome: env.m(() => ({ matchedRules: [] })),
    setExtensionActionOptions: env.m(() => {}, { voidResult: true }),
    onRuleMatchedDebug: env.event('declarativeNetRequest.onRuleMatchedDebug'),
  })
}
